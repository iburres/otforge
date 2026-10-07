/**
 * suricata-rules.test.ts — Unit tests for the Save-time custom rule check.
 *
 * The check runs the real `suricata -T` in Docker; these tests cover only the pure
 * parts: pairing each rejected rule with its reason, the hints, the rule count, and
 * telling "rules invalid" apart from "check couldn't run".
 *
 * Fixtures are verbatim `suricata -T` output captured from the otforge-suricata image
 * (Suricata 8.0.6) on 2026-10-07, not hand-written approximations, so a change in
 * how this code reads the output is tested against what Suricata actually prints.
 */

import { describe, it, expect } from 'vitest'
import {
  parseRuleTestOutput,
  interpretRuleTest,
  countRules,
  ruleHint,
  RC_MARKER,
  RULE_TEST_SCRIPT,
  CUSTOM_RULES_PATH
} from '../suricata-rules'

/** Real output: multi-line rule (line 2) and misspelled keyword (line 4). */
const MULTILINE_AND_TYPO = `Notice: suricata: This is Suricata version 8.0.6 RELEASE running in SYSTEM mode
Info: suricata: Running suricata under test mode
Error: detect-parse: no rule options.
Error: detect: error parsing signature "alert tcp any any -> any 502" from file /etc/suricata/rules/custom.rules at line 2
Error: detect-parse: unknown rule keyword 'conten'.
Error: detect: error parsing signature "alert tcp any any -> any 502 (msg:"typo"; conten:"x"; sid:9900003; rev:1;)" from file /etc/suricata/rules/custom.rules at line 4
Info: detect: 3 rule files processed. 12 rules successfully loaded, 2 rules failed, 0 rules skipped
Error: suricata: Loading signatures failed.
`

/** Real output: duplicate sid (custom vs custom), undefined variable, duplicate of a bundled sid. */
const DUP_AND_UNDEFINED_VAR = `Error: detect-parse: Duplicate signature "alert tcp any any -> any 502 (msg:"dup"; sid:9900001; rev:1;)"
Error: detect: error parsing signature "alert tcp any any -> any 502 (msg:"dup"; sid:9900001; rev:1;)" from file /etc/suricata/rules/custom.rules at line 2
Error: rule-vars: Variable "PLC_NET" is not defined in configuration file
Error: detect: error parsing signature "alert tcp $PLC_NET any -> any 502 (msg:"undef var"; sid:9900004; rev:1;)" from file /etc/suricata/rules/custom.rules at line 3
Error: detect-parse: Duplicate signature "alert tcp any any -> any 502 (msg:"dup of bundled"; sid:9000002; rev:1;)"
Error: detect: error parsing signature "alert tcp any any -> any 502 (msg:"dup of bundled"; sid:9000002; rev:1;)" from file /etc/suricata/rules/custom.rules at line 4
Info: detect: 3 rule files processed. 12 rules successfully loaded, 3 rules failed, 0 rules skipped
Error: suricata: Loading signatures failed.
`

const PASSING = `Info: detect: 2 rule files processed. 13 rules successfully loaded, 0 rules failed, 0 rules skipped
Info: detect: 13 signatures processed. 2 are IP-only rules, 5 are inspecting packet payload, 0 inspect application layer, 0 are decoder event only
`

describe('parseRuleTestOutput', () => {
  it('pairs each rejected line with the reason printed just before it', () => {
    expect(parseRuleTestOutput(MULTILINE_AND_TYPO)).toEqual([
      { line: 2, reason: 'no rule options.', hint: expect.stringContaining('line break') },
      { line: 4, reason: "unknown rule keyword 'conten'.", hint: undefined }
    ])
  })

  it('handles duplicate sids and undefined variables', () => {
    const errors = parseRuleTestOutput(DUP_AND_UNDEFINED_VAR)
    expect(errors.map(e => e.line)).toEqual([2, 3, 4])
    expect(errors[1].reason).toBe('Variable "PLC_NET" is not defined in configuration file')
    // The "Duplicate signature" reason itself contains a quoted rule with colons;
    // only the "Error: <module>: " prefix may be stripped.
    expect(errors[0].reason).toBe(
      'Duplicate signature "alert tcp any any -> any 502 (msg:"dup"; sid:9900001; rev:1;)"'
    )
    expect(errors[0].hint).toContain('unique sid')
    expect(errors[2].hint).toContain('unique sid')
  })

  it('ignores errors in rule files other than the custom one', () => {
    const bundled = `Error: detect-parse: no rule options.
Error: detect: error parsing signature "alert tcp any any -> any 1" from file /etc/suricata/rules/otforge.rules at line 9
`
    expect(parseRuleTestOutput(bundled)).toEqual([])
  })

  it('returns nothing for passing output', () => {
    expect(parseRuleTestOutput(PASSING)).toEqual([])
  })
})

describe('interpretRuleTest', () => {
  const rules = 'alert tcp any any -> any 502 (msg:"a"; sid:9100001; rev:1;)\n'

  it('reports valid when Suricata exits 0', () => {
    expect(interpretRuleTest(`${PASSING}${RC_MARKER}0\n`, rules)).toEqual({
      status: 'valid',
      ruleCount: 1,
      errors: []
    })
  })

  it('reports invalid with per-line errors when Suricata exits non-zero', () => {
    const result = interpretRuleTest(`${MULTILINE_AND_TYPO}${RC_MARKER}1\n`, rules)
    expect(result.status).toBe('invalid')
    expect(result.errors).toHaveLength(2)
  })

  it('reports invalid with a message when no line is named', () => {
    const output = `Error: suricata: Loading signatures failed.\n${RC_MARKER}1\n`
    const result = interpretRuleTest(output, rules)
    expect(result.status).toBe('invalid')
    expect(result.errors).toEqual([])
    expect(result.message).toBe('Loading signatures failed.')
  })

  it('reports unavailable, not valid, when the script never finished', () => {
    // No RC marker: the test was cut off, so nothing is known about the rules.
    expect(interpretRuleTest(PASSING, rules).status).toBe('unavailable')
  })
})

describe('countRules', () => {
  it('counts a backslash-continued rule once', () => {
    const text = [
      'alert tcp any any -> any 502 (msg:"one"; \\',
      '  content:"|05|"; sid:9100001; rev:1;)',
      '# a comment',
      '',
      'drop tcp any any -> any 503 (msg:"two"; sid:9100002; rev:1;)'
    ].join('\n')
    expect(countRules(text)).toBe(2)
  })
})

describe('ruleHint', () => {
  it('has no hint for reasons without a common cause', () => {
    expect(ruleHint("unknown rule keyword 'conten'.")).toBeUndefined()
  })
})

describe('RULE_TEST_SCRIPT', () => {
  it('writes stdin to the path the parser looks for, and tests without Emerging Threats', () => {
    expect(RULE_TEST_SCRIPT).toContain(`cat > ${CUSTOM_RULES_PATH}`)
    expect(RULE_TEST_SCRIPT).toContain('--include /tmp/rule-test/validate.yaml')
    expect(RULE_TEST_SCRIPT).not.toContain('suricata.rules\\n')
  })
})
