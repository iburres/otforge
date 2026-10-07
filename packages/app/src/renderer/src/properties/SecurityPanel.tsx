/**
 * SecurityPanel.tsx — Firewall ACL editor and IDS/IPS configuration panels (Phase 5).
 *
 * Exports two sub-panels rendered inside PropertiesPanel when a security device is selected:
 *
 *   FirewallPanel — shown when a "firewall" device is selected on the canvas.
 *     Edits scenario.security.defaultFirewallPolicy (deny-by-default toggle) and
 *     scenario.security.firewallRules (ACL rule list with source/dest zone, protocol,
 *     port, and allow/deny action). These values are serialized to FW_DEFAULT_POLICY
 *     and FW_RULES_JSON env vars by compose-generator.ts and applied via nftables
 *     inside the firewall container at simulation startup.
 *
 *   IDSPanel — shown when an "ids-ips" device is selected on the canvas.
 *     Edits scenario.security.ids.enabledRulesets (Suricata Emerging Threats rulesets),
 *     scenario.security.ids.zeekScripts (Zeek ICS protocol analyzers), and
 *     scenario.security.ids.disabledRuleIds (SIDs to suppress in threshold.conf).
 *     These values are serialized to IDS_RULESETS, IDS_DISABLED_SIDS, and ZEEK_SCRIPTS
 *     env vars by compose-generator.ts and read by the Suricata/Zeek entrypoints.
 *
 * Neither panel modifies DeviceConfig directly — security config lives at the scenario
 * level (SecurityLayer), not per-device. The selected firewall/IDS-IPS node is just
 * the UI entry point into the shared security configuration.
 *
 * Data flow:
 *   App.tsx holds scenario.security in state
 *   → passes it as `security` prop to PropertiesPanel
 *   → PropertiesPanel passes it to FirewallPanel / IDSPanel
 *   → panels call onSecurityChange(updater) to write back
 *   → App.tsx applies updater to scenario.security and re-renders
 */

import { useState, useCallback, useRef } from 'react'
import type { SecurityLayer, ACLRule, NetworkZone, SuricataRuleCheckResult } from '@otforge/schema'

/** Props shared by both security sub-panels. */
interface SecurityPanelProps {
  /** Full scenario-level security configuration. */
  security: SecurityLayer
  /** Updater callback — same (prev => next) pattern used across the app. */
  onSecurityChange: (updater: (s: SecurityLayer) => SecurityLayer) => void
  /** Canvas node ID of the selected device — used by FirewallPanel for runtime reload. */
  nodeId?: string
  /** True when a simulation is actively running — enables the Apply Rules button. */
  simRunning?: boolean
}

// ── Firewall Panel ─────────────────────────────────────────────────────────────

/**
 * Zone dropdown options for ACL rule source/destination selectors.
 * "Any" maps to no subnet restriction in the nftables rule.
 */
const ZONE_OPTIONS: { value: NetworkZone | 'any'; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'ot', label: 'OT' },
  { value: 'control', label: 'CTRL' },
  { value: 'plant-dmz', label: 'PDMZ' },
  { value: 'enterprise', label: 'ENT' },
  { value: 'internet-dmz', label: 'IDMZ' },
  { value: 'attacker', label: 'RED' }
]

/** Protocol options for the ACL rule form. Maps to nft protocol matchers. */
const PROTO_OPTIONS = ['tcp', 'udp', 'icmp', 'any'] as const
type AclProto = (typeof PROTO_OPTIONS)[number]

/** Empty state for the "add rule" inline form. */
const EMPTY_FORM = {
  sourceZone: 'any' as NetworkZone | 'any',
  destinationZone: 'any' as NetworkZone | 'any',
  protocol: 'tcp' as AclProto,
  destinationPort: '',
  action: 'allow' as 'allow' | 'deny',
  comment: ''
}

/**
 * FirewallPanel — edits scenario.security.defaultFirewallPolicy and firewallRules.
 *
 * Shows:
 *   1. Default policy toggle (DENY / ALLOW) — determines the nftables chain policy
 *      when no ACL rule matches a forwarded packet.
 *   2. ACL rules table — compact grid showing all saved rules with delete buttons.
 *   3. Add-rule form — inline two-row form for building a new ACLRule.
 *
 * Saved rules are written to FW_RULES_JSON by compose-generator.ts and applied
 * one-for-one as `nft add rule inet ics_fw forward …` lines in entrypoint.sh.
 */
export function FirewallPanel({
  security,
  onSecurityChange,
  nodeId,
  simRunning
}: SecurityPanelProps) {
  /** Local form state for the "add rule" inputs — not committed until Add is clicked. */
  const [form, setForm] = useState(EMPTY_FORM)

  /** Tracks the in-progress / success / error state of the Apply Rules IPC call. */
  const [applyState, setApplyState] = useState<'idle' | 'applying' | 'ok' | 'error'>('idle')

  /** Flip the default policy between deny-by-default and allow-by-default. */
  const togglePolicy = useCallback(() => {
    onSecurityChange(s => ({
      ...s,
      defaultFirewallPolicy: s.defaultFirewallPolicy === 'deny' ? 'allow' : 'deny'
    }))
  }, [onSecurityChange])

  /**
   * Commits the current form values as a new ACLRule and appends it to firewallRules.
   * Port validation: empty string or "any" both become the literal "any".
   */
  const addRule = useCallback(() => {
    const portRaw = form.destinationPort.trim()
    const portVal: number | 'any' = portRaw === '' || portRaw === 'any' ? 'any' : Number(portRaw)

    const newRule: ACLRule = {
      id: `rule-${Date.now()}`,
      sourceZone: form.sourceZone,
      destinationZone: form.destinationZone,
      protocol: form.protocol,
      destinationPort: portVal,
      action: form.action,
      comment: form.comment.trim() || undefined
    }
    onSecurityChange(s => ({ ...s, firewallRules: [...s.firewallRules, newRule] }))
    setForm(EMPTY_FORM)
  }, [form, onSecurityChange])

  /** Removes a single ACL rule by its id. */
  const deleteRule = useCallback(
    (id: string) => {
      onSecurityChange(s => ({ ...s, firewallRules: s.firewallRules.filter(r => r.id !== id) }))
    },
    [onSecurityChange]
  )

  /**
   * Pushes the current rules to the running firewall container via IPC so
   * students don't need to restart the simulation after each rule change.
   */
  const applyRules = useCallback(async () => {
    if (!nodeId || !simRunning) return
    setApplyState('applying')
    try {
      const result = await window.electronAPI.firewall.reload({
        nodeId,
        rules: security.firewallRules,
        defaultPolicy: security.defaultFirewallPolicy === 'deny' ? 'drop' : 'accept'
      })
      setApplyState(result.ok ? 'ok' : 'error')
    } catch {
      setApplyState('error')
    }
    setTimeout(() => setApplyState('idle'), 3000)
  }, [nodeId, simRunning, security.firewallRules, security.defaultFirewallPolicy])

  const isDeny = security.defaultFirewallPolicy === 'deny'

  return (
    <>
      {/* ── Default policy toggle ─────────────────────────────────────────── */}
      {/* deny-by-default is the ICS best practice — explicit allows only.    */}
      <section className="prop-section">
        <div className="prop-section-title">Default Policy</div>
        <div className="prop-row">
          <span className="prop-label">Unmatched traffic</span>
          <button
            className={`fw-policy-btn ${isDeny ? 'fw-policy-deny' : 'fw-policy-allow'}`}
            onClick={togglePolicy}
            title="Click to toggle: DENY blocks all unmatched traffic; ALLOW passes it"
          >
            {isDeny ? 'DENY' : 'ALLOW'}
          </button>
        </div>
      </section>

      {/* ── ACL rules table ────────────────────────────────────────────────── */}
      <section className="prop-section">
        <div className="prop-section-title">
          ACL Rules
          {security.firewallRules.length > 0 && (
            <span className="prop-section-badge">{security.firewallRules.length}</span>
          )}
        </div>

        {security.firewallRules.length === 0 ? (
          <p className="fw-rules-empty">
            No rules — default policy applies to all forwarded traffic.
          </p>
        ) : (
          <div className="fw-rules-table">
            {/* Column header */}
            <div className="fw-rules-header">
              <span>Src</span>
              <span>Dst</span>
              <span>Proto</span>
              <span>Port</span>
              <span>Action</span>
              <span />
            </div>
            {/* One row per ACLRule */}
            {security.firewallRules.map(rule => (
              <div key={rule.id} className="fw-rule-row" title={rule.comment ?? ''}>
                <span className="fw-zone">{rule.sourceZone}</span>
                <span className="fw-zone">{rule.destinationZone}</span>
                <span className="fw-cell">{rule.protocol}</span>
                <span className="fw-cell">{String(rule.destinationPort)}</span>
                <span className={`fw-action fw-action-${rule.action}`}>{rule.action}</span>
                <button
                  className="fw-rule-delete"
                  onClick={() => deleteRule(rule.id)}
                  aria-label="Delete rule"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ── Add rule form ────────────────────────────────────────────────── */}
        {/* Row 1: zone → zone, protocol, port, action dropdowns */}
        <div className="fw-add-form">
          <div className="fw-add-row1">
            <select
              className="fw-select"
              value={form.sourceZone}
              onChange={e =>
                setForm(f => ({ ...f, sourceZone: e.target.value as NetworkZone | 'any' }))
              }
              aria-label="Source zone"
            >
              {ZONE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            <span className="fw-arrow">→</span>

            <select
              className="fw-select"
              value={form.destinationZone}
              onChange={e =>
                setForm(f => ({ ...f, destinationZone: e.target.value as NetworkZone | 'any' }))
              }
              aria-label="Destination zone"
            >
              {ZONE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            <select
              className="fw-select fw-select-sm"
              value={form.protocol}
              onChange={e => setForm(f => ({ ...f, protocol: e.target.value as AclProto }))}
              aria-label="Protocol"
            >
              {PROTO_OPTIONS.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>

            <input
              className="fw-input fw-input-port"
              type="text"
              placeholder="port"
              value={form.destinationPort}
              onChange={e => setForm(f => ({ ...f, destinationPort: e.target.value }))}
              aria-label="Destination port"
            />

            <select
              className="fw-select fw-select-sm fw-select-action"
              value={form.action}
              onChange={e => setForm(f => ({ ...f, action: e.target.value as 'allow' | 'deny' }))}
              aria-label="Action"
            >
              <option value="allow">allow</option>
              <option value="deny">deny</option>
            </select>
          </div>

          {/* Row 2: optional comment + Add button */}
          <div className="fw-add-row2">
            <input
              className="fw-input fw-input-comment"
              type="text"
              placeholder="Comment (optional)"
              value={form.comment}
              onChange={e => setForm(f => ({ ...f, comment: e.target.value }))}
            />
            <button className="btn btn-sm btn-primary fw-add-btn" onClick={addRule}>
              + Add
            </button>
          </div>
        </div>
      </section>

      {/* ── Apply Rules ────────────────────────────────────────────────────────── */}
      {/* Pushes the current ruleset to the running firewall container so students */}
      {/* can reconfigure without restarting the simulation.                       */}
      <section className="prop-section">
        <div className="fw-apply-row">
          <button
            className={`btn btn-sm fw-apply-btn ${
              applyState === 'ok'
                ? 'btn-success'
                : applyState === 'error'
                  ? 'btn-danger'
                  : 'btn-secondary'
            }`}
            onClick={applyRules}
            disabled={!simRunning || applyState === 'applying'}
            title={
              simRunning
                ? 'Apply current rules to the running firewall container'
                : 'Start the simulation to apply rules'
            }
          >
            {applyState === 'applying'
              ? 'Applying…'
              : applyState === 'ok'
                ? '✓ Applied'
                : applyState === 'error'
                  ? '✗ Failed'
                  : 'Apply Rules'}
          </button>
          {!simRunning && <span className="fw-apply-hint">Start simulation to apply</span>}
        </div>
      </section>
    </>
  )
}

// ── IDS / IPS Panel ────────────────────────────────────────────────────────────

/**
 * Available Suricata Emerging Threats Open rulesets for ICS environments.
 * IDs match suricata-update source names; hint is shown as a tooltip.
 */
const SURICATA_RULESETS: { id: string; label: string; hint: string }[] = [
  {
    id: 'emerging-scada',
    label: 'Emerging SCADA',
    hint: 'Detects SCADA protocol anomalies and known attack patterns'
  },
  {
    id: 'emerging-modbus',
    label: 'Emerging Modbus',
    hint: 'Modbus TCP abuse, enumeration, and coil manipulation'
  },
  {
    id: 'emerging-dnp3',
    label: 'Emerging DNP3',
    hint: 'DNP3 protocol anomalies and outstation abuse'
  },
  {
    id: 'emerging-ics',
    label: 'Emerging ICS',
    hint: 'Broad ICS/SCADA threat intelligence signatures'
  }
]

/**
 * Zeek ICS protocol analysis scripts shipped with the zeek container image.
 * Script filenames must match files under /opt/zeek/share/zeek/site/ in the container.
 */
const ZEEK_SCRIPTS_OPTIONS: { id: string; label: string; hint: string }[] = [
  {
    id: 'modbus.zeek',
    label: 'Modbus analyzer',
    hint: 'Logs Modbus TCP transactions to modbus.log'
  },
  {
    id: 'dnp3.zeek',
    label: 'DNP3 analyzer',
    hint: 'Logs DNP3 sessions and function codes to dnp3.log'
  }
]

/**
 * IDSPanel — edits scenario.security.ids (Suricata rulesets, Zeek scripts, disabled SIDs,
 * and custom Suricata rules).
 *
 * Shows:
 *   1. Suricata ruleset checkboxes — which Emerging Threats Open categories to enable.
 *   2. Zeek script checkboxes — which ICS protocol analyzers to load.
 *   3. Disabled SIDs text input — comma-separated SID numbers to suppress (committed on blur).
 *   4. Custom Rules textarea — raw Suricata rule text saved to scenario and injected as
 *      IDS_CUSTOM_RULES_B64 by compose-generator → decoded to custom.rules at container start.
 *
 * Changes write back to scenario.security.ids via onSecurityChange. The compose generator
 * reads these and passes IDS_RULESETS, ZEEK_SCRIPTS, IDS_DISABLED_SIDS, and
 * IDS_CUSTOM_RULES_B64 env vars to the Suricata and Zeek containers at simulation start.
 */
export function IDSPanel({ security, onSecurityChange }: SecurityPanelProps) {
  /**
   * Local draft of the disabled-SIDs text field — committed to the scenario on blur.
   * Held locally to avoid re-rendering the scenario on every keystroke.
   */
  const [sidText, setSidText] = useState(security.ids.disabledRuleIds.join(', '))

  /**
   * Local draft of the custom rules textarea — committed on Save button click.
   * Multiline Suricata rule text; each non-empty line should be a valid rule.
   */
  const [customRulesDraft, setCustomRulesDraft] = useState(security.ids.customRules ?? '')

  /** Toggle a single Suricata ruleset on or off. */
  const toggleRuleset = useCallback(
    (id: string) => {
      onSecurityChange(s => {
        const cur = s.ids.enabledRulesets
        const next = cur.includes(id) ? cur.filter(r => r !== id) : [...cur, id]
        return { ...s, ids: { ...s.ids, enabledRulesets: next } }
      })
    },
    [onSecurityChange]
  )

  /** Toggle a single Zeek script on or off. */
  const toggleZeekScript = useCallback(
    (id: string) => {
      onSecurityChange(s => {
        const cur = s.ids.zeekScripts
        const next = cur.includes(id) ? cur.filter(r => r !== id) : [...cur, id]
        return { ...s, ids: { ...s.ids, zeekScripts: next } }
      })
    },
    [onSecurityChange]
  )

  /**
   * Parse the SID text field and commit valid integers to the scenario.
   * Called on blur so the scenario isn't updated on every keystroke.
   * Invalid tokens (non-numeric) are silently discarded.
   */
  const commitSids = useCallback(() => {
    const sids = sidText
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n))
    onSecurityChange(s => ({ ...s, ids: { ...s.ids, disabledRuleIds: sids } }))
  }, [sidText, onSecurityChange])

  /**
   * Result of the last Save-time rule check, or null before the first check / after
   * the rules were cleared. Shown under the textarea.
   */
  const [ruleCheck, setRuleCheck] = useState<SuricataRuleCheckResult | null>(null)

  /** True while a rule check is running (Save button shows "Checking…"). */
  const [checkingRules, setCheckingRules] = useState(false)

  /**
   * Increments on every Save. A check result is applied only if no newer Save started
   * while it ran, so a slow earlier check can't overwrite a newer one's result.
   */
  const checkSeq = useRef(0)

  /**
   * Commit the custom rules draft to scenario state, then check it with Suricata.
   * Stores the raw rule text; compose-generator base64-encodes it when building
   * the IDS_CUSTOM_RULES_B64 env var for the Suricata container.
   * Empty string is stored as undefined so serialized scenarios stay clean.
   *
   * Saving never waits on the check and never depends on it: rules are saved even when
   * Docker is unavailable, and the sensor re-checks them at start-up anyway. The check
   * exists so a mistake shows up here, next to the rule, instead of as "no alerts".
   *
   * The draft is replaced with the trimmed text so the line numbers Suricata reports
   * (counted in the saved text) match the lines in the textarea.
   */
  const commitCustomRules = useCallback(async () => {
    const trimmed = customRulesDraft.trim()
    setCustomRulesDraft(trimmed)
    onSecurityChange(s => ({
      ...s,
      ids: { ...s.ids, customRules: trimmed.length > 0 ? trimmed : undefined }
    }))

    const seq = ++checkSeq.current
    if (trimmed.length === 0) {
      setRuleCheck(null)
      setCheckingRules(false)
      return
    }
    setCheckingRules(true)
    let result: SuricataRuleCheckResult
    try {
      result = await window.electronAPI.ids.validateRules(trimmed)
    } catch {
      result = {
        status: 'unavailable',
        ruleCount: 0,
        errors: [],
        message: 'The rule check could not run.'
      }
    }
    if (seq !== checkSeq.current) return
    setRuleCheck(result)
    setCheckingRules(false)
  }, [customRulesDraft, onSecurityChange])

  /** Lines of the saved rules, for quoting a rejected rule back to the student. */
  const savedRuleLines = (security.ids.customRules ?? '').split('\n')

  return (
    <>
      {/* ── Suricata rulesets ─────────────────────────────────────────────── */}
      <section className="prop-section">
        <div className="prop-section-title">Suricata Rulesets</div>
        <div className="ids-check-list">
          {SURICATA_RULESETS.map(rs => (
            <label key={rs.id} className="ids-check-item" title={rs.hint}>
              <input
                type="checkbox"
                className="ids-checkbox"
                checked={security.ids.enabledRulesets.includes(rs.id)}
                onChange={() => toggleRuleset(rs.id)}
              />
              <span className="ids-check-label">{rs.label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* ── Zeek scripts ─────────────────────────────────────────────────── */}
      <section className="prop-section">
        <div className="prop-section-title">Zeek Scripts</div>
        <div className="ids-check-list">
          {ZEEK_SCRIPTS_OPTIONS.map(sc => (
            <label key={sc.id} className="ids-check-item" title={sc.hint}>
              <input
                type="checkbox"
                className="ids-checkbox"
                checked={security.ids.zeekScripts.includes(sc.id)}
                onChange={() => toggleZeekScript(sc.id)}
              />
              <span className="ids-check-label">{sc.label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* ── Disabled SIDs ────────────────────────────────────────────────── */}
      {/* Writes suppress entries to threshold.conf in the Suricata container. */}
      <section className="prop-section">
        <div className="prop-section-title">Suppressed SIDs</div>
        <input
          className="ids-sids-input"
          type="text"
          placeholder="e.g. 2001219, 2010936"
          value={sidText}
          onChange={e => setSidText(e.target.value)}
          onBlur={commitSids}
        />
        <p className="ids-sids-hint">
          Comma-separated Suricata SID numbers to suppress (false-positive overrides).
        </p>
      </section>

      {/* ── Custom Suricata Rules ─────────────────────────────────────────── */}
      {/*
       * Each line is a standard Suricata rule in the format:
       *   action proto src_ip src_port -> dst_ip dst_port (options)
       *
       * Example — alert on any Modbus Write Single Coil (function code 05, the byte
       * right after the 7-byte MBAP header):
       *   alert tcp any any -> $HOME_NET 502 (msg:"Modbus Write Single Coil"; content:"|05|"; offset:7; depth:1; sid:9100101; rev:1;)
       * Use only variables defined in containers/suricata/suricata.yaml ($HOME_NET,
       * $EXTERNAL_NET, $MODBUS_PORTS, ...); an undefined one makes Suricata reject the rule.
       * Save also checks the rules with the real Suricata (see commitCustomRules).
       *
       * Rules are saved to the scenario file and injected as IDS_CUSTOM_RULES_B64
       * at simulation start. Suricata loads them from /etc/suricata/rules/custom.rules.
       * Click Save to commit — changes do not apply until the simulation restarts.
       */}
      <section className="prop-section">
        <div className="prop-section-title">
          Custom Rules
          {(security.ids.customRules?.trim().length ?? 0) > 0 && (
            <span className="prop-section-badge">
              {
                security.ids
                  .customRules!.trim()
                  .split('\n')
                  .filter(l => l.trim().length > 0).length
              }
            </span>
          )}
        </div>
        <textarea
          className="ids-custom-rules-editor"
          value={customRulesDraft}
          onChange={e => setCustomRulesDraft(e.target.value)}
          placeholder={
            'alert tcp any any -> $HOME_NET 502 (msg:"Modbus Write Single Coil"; content:"|05|"; offset:7; depth:1; sid:9100101; rev:1;)'
          }
          spellCheck={false}
          aria-label="Custom Suricata rules"
          rows={6}
        />
        <div className="ids-custom-rules-footer">
          <p className="ids-sids-hint">
            Standard Suricata rule syntax, one rule per line. Use SIDs ≥ 9100000: OTForge&apos;s
            bundled rules use 9000001–9000050 and Emerging Threats uses 2000000–2999999. Restart
            simulation to apply.
          </p>
          <button
            className="btn btn-sm btn-secondary ids-custom-rules-save"
            onClick={commitCustomRules}
            disabled={checkingRules}
          >
            {checkingRules ? 'Checking…' : 'Save Rules'}
          </button>
        </div>

        {/* ── Save-time rule check result ─────────────────────────────────── */}
        {/* Suricata's own verdict on the saved rules. A rejected rule is skipped by */}
        {/* the sensor (it keeps running on the rest), so it would never alert.      */}
        {ruleCheck && !checkingRules && (
          <div className={`ids-rule-check ids-rule-check-${ruleCheck.status}`} role="status">
            {ruleCheck.status === 'valid' && (
              <p className="ids-rule-check-title">
                ✓ Suricata accepted{' '}
                {ruleCheck.ruleCount === 1 ? 'the rule' : `all ${ruleCheck.ruleCount} rules`}.
              </p>
            )}

            {ruleCheck.status === 'invalid' && (
              <>
                <p className="ids-rule-check-title">
                  {ruleCheck.errors.length > 0
                    ? `✗ ${ruleCheck.errors.length} of ${ruleCheck.ruleCount} rule${ruleCheck.ruleCount === 1 ? '' : 's'} will NOT load. The sensor skips ${ruleCheck.errors.length === 1 ? 'it' : 'them'}, so ${ruleCheck.errors.length === 1 ? 'it' : 'they'} can never alert:`
                    : '✗ Suricata rejected these rules:'}
                </p>
                {ruleCheck.errors.map(err => (
                  <div key={err.line} className="ids-rule-check-error">
                    <div className="ids-rule-check-reason">
                      Line {err.line}: {err.reason}
                    </div>
                    {savedRuleLines[err.line - 1] !== undefined && (
                      <code className="ids-rule-check-rule">{savedRuleLines[err.line - 1]}</code>
                    )}
                    {err.hint && <div className="ids-rule-check-hint">{err.hint}</div>}
                  </div>
                ))}
                {ruleCheck.message && <p className="ids-rule-check-reason">{ruleCheck.message}</p>}
              </>
            )}

            {ruleCheck.status === 'unavailable' && (
              <p className="ids-rule-check-title">
                Saved, but not checked: {ruleCheck.message} The sensor checks them again when the
                simulation starts.
              </p>
            )}
          </div>
        )}
      </section>
    </>
  )
}
