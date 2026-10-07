/**
 * suricata-rules.ts — Check custom Suricata rules before they reach the sensor.
 *
 * Why this exists: the Suricata container runs with --init-errors-fatal, and a single
 * malformed custom rule used to kill it at init on every restart. The student saw only
 * "no alerts", which looks the same as "the attack didn't work" — a multi-line rule
 * cost one student several days that way (July 2026).
 *
 * Two layers now guard against that:
 *   1. containers/suricata/entrypoint.sh tests the rules at sensor start, comments out
 *      the bad ones, and starts with the rest (the safety net).
 *   2. This module, used when the student clicks Save in the IDS panel, so the error
 *      appears next to the rule they just typed instead of in a container log.
 *
 * The check runs the REAL `suricata -T` (test mode) inside a throwaway container from
 * the same sensor image the simulation uses, so "valid" here means the sensor will
 * accept it. A TypeScript re-implementation of Suricata's grammar would drift.
 *
 * This file holds the pure parts (script text, output parsing, hints) so they can be
 * unit-tested against real Suricata output. DockerClient.validateSuricataRules() runs it.
 */

import type { SuricataRuleCheckResult, SuricataRuleError } from '@otforge/schema'

/** The sensor image. compose-generator.ts starts the IDS from this same image. */
export const SURICATA_IMAGE = 'ghcr.io/iburres/otforge-suricata:latest'

/** Where the test script writes the rules inside the throwaway container. */
export const CUSTOM_RULES_PATH = '/etc/suricata/rules/custom.rules'

/**
 * Marker the test script prints with Suricata's exit code. The script itself always
 * exits 0, so a non-zero `docker run` exit means Docker failed (no image, daemon
 * down), never "the rules were bad". That keeps the two cases from being confused.
 */
export const RC_MARKER = '__OTFORGE_RULE_TEST_RC='

/** Suricata rule actions; a line starting with one of these begins a rule. */
const RULE_START = /^(alert|drop|pass|reject|rejectsrc|rejectdst|rejectboth)\s/

/**
 * Shell script run inside the sensor image. Reads the rules from stdin.
 *
 * Mirrors the entrypoint's validation exactly:
 *   - an empty suricata.rules placeholder (the downloaded Emerging Threats file isn't in
 *     a fresh container, and --init-errors-fatal treats a missing rule file as fatal);
 *   - a rule-files overlay limited to the bundled otforge.rules + custom.rules, the
 *     same set the entrypoint tests (~0.1 s instead of ~22 s with all ET rules).
 * A custom sid that collides with a downloaded ET rule can't be seen here; the
 * entrypoint catches that one at sensor start.
 */
export const RULE_TEST_SCRIPT = [
  'mkdir -p /var/lib/suricata/rules /tmp/rule-test',
  'touch /var/lib/suricata/rules/suricata.rules',
  `cat > ${CUSTOM_RULES_PATH}`,
  `printf '%%YAML 1.1\\n---\\nrule-files:\\n  - /etc/suricata/rules/otforge.rules\\n  - ${CUSTOM_RULES_PATH}\\n' > /tmp/rule-test/validate.yaml`,
  'suricata -T -c /etc/suricata/otforge.yaml --include /tmp/rule-test/validate.yaml --init-errors-fatal -l /tmp/rule-test 2>&1',
  `echo "${RC_MARKER}$?"`
].join('\n')

/**
 * Counts rule statements: lines that start with an action keyword. A `\`-continued
 * rule counts once because only its first line starts with an action.
 *
 * @param rulesText - Custom rules exactly as they will be saved.
 */
export function countRules(rulesText: string): number {
  return rulesText.split('\n').filter(l => RULE_START.test(l)).length
}

/**
 * Returns a plain-language hint for the mistakes students actually make, or undefined.
 * Kept in sync with the hints in containers/suricata/entrypoint.sh.
 *
 * @param reason - Suricata's reason text for one rejected rule.
 */
export function ruleHint(reason: string): string | undefined {
  // A rule ends at the line break, so a pretty-printed rule reaches the parser as a
  // bare header with no (...) options. Suricata only says "no rule options".
  if (reason.includes('no rule options')) {
    return 'A rule ends at the line break, so its options in (...) never reached the parser. Put the rule on one line, or end each wrapped line with a backslash (\\).'
  }
  if (reason.includes('Duplicate signature')) {
    return 'Every rule needs a unique sid. This sid is already used by another loaded rule (custom or bundled).'
  }
  return undefined
}

/**
 * Pairs each rejected custom rule with its reason.
 *
 * For every rule it can't load, Suricata prints the reason, then a summary line:
 *   Error: detect-parse: unknown rule keyword 'conten'.
 *   Error: detect: error parsing signature "..." from file <path> at line 4
 * The reason is the most recent "Error:" line before the summary, minus its
 * "Error: <module>: " prefix.
 *
 * @param output    - Combined stdout/stderr of `suricata -T`.
 * @param rulesPath - Path of the custom rules file in that run; errors in other rule
 *                    files (the bundled set) are ignored here.
 */
export function parseRuleTestOutput(
  output: string,
  rulesPath = CUSTOM_RULES_PATH
): SuricataRuleError[] {
  const errors: SuricataRuleError[] = []
  const summaryMarker = `from file ${rulesPath} at line `
  let lastReason = ''

  for (const raw of output.split('\n')) {
    const line = raw.trimEnd()
    if (line.includes('error parsing signature') && line.includes(summaryMarker)) {
      const lineNo = parseInt(
        line.slice(line.lastIndexOf(summaryMarker) + summaryMarker.length),
        10
      )
      if (!isNaN(lineNo)) {
        const reason = lastReason || 'Suricata could not parse this rule.'
        const hint = ruleHint(reason)
        // exactOptionalPropertyTypes: omit `hint` rather than set it to undefined.
        errors.push(hint ? { line: lineNo, reason, hint } : { line: lineNo, reason })
      }
      lastReason = ''
    } else if (line.startsWith('Error: ')) {
      lastReason = line.replace(/^Error: [^:]*: /, '')
    }
  }
  return errors
}

/**
 * Turns the test container's output into the result the IDS panel shows.
 *
 * @param output    - Everything the test script printed (Suricata output + RC marker).
 * @param rulesText - The rules that were tested, for the rule count.
 */
export function interpretRuleTest(output: string, rulesText: string): SuricataRuleCheckResult {
  const ruleCount = countRules(rulesText)
  const rcMatch = output.match(new RegExp(`${RC_MARKER}(\\d+)`))
  if (!rcMatch) {
    // The script never reached the end, so Suricata didn't finish its test.
    return {
      status: 'unavailable',
      ruleCount,
      errors: [],
      message: 'The rule check did not finish.'
    }
  }
  if (rcMatch[1] === '0') return { status: 'valid', ruleCount, errors: [] }

  const errors = parseRuleTestOutput(output)
  if (errors.length > 0) return { status: 'invalid', ruleCount, errors }

  // Failed, but not tied to a rule line. Surface Suricata's own error lines.
  const errorLines = output
    .split('\n')
    .filter(l => l.startsWith('Error: '))
    .map(l => l.replace(/^Error: [^:]*: /, '').trim())
  return {
    status: 'invalid',
    ruleCount,
    errors: [],
    message: errorLines.join(' ') || 'Suricata rejected the rules without naming a line.'
  }
}
