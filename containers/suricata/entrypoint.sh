#!/bin/bash
# entrypoint.sh — Suricata IDS/IPS startup for the otforge-suricata container.
#
# Reads security configuration injected by compose-generator.ts and starts Suricata
# in AF_PACKET mode on all detected simulation interfaces.
#
# Environment variables:
#   DEVICE_ID          — Device node ID from the scenario (logged on start)
#   SURICATA_IFACE     — Network interface to monitor (default: auto-detect all 10.x ifaces)
#   IDS_RULESETS       — Comma-separated Emerging Threats ruleset IDs to enable.
#                         e.g. "emerging-scada,emerging-modbus"
#                         When empty, defaults to "emerging-scada,emerging-modbus".
#                         Used to filter which suricata-update sources are enabled.
#   IDS_DISABLED_SIDS  — Comma-separated Suricata SID numbers to suppress.
#                         e.g. "2001219,2010936"
#                         Writes a /etc/suricata/threshold.conf suppress block so
#                         the rules still load but never generate alerts for those SIDs.
#                         Useful for suppressing known false positives in lab environments.

set -e

RULESETS="${IDS_RULESETS:-emerging-scada,emerging-modbus}"
DISABLED_SIDS="${IDS_DISABLED_SIDS:-}"
CUSTOM_RULES_B64="${IDS_CUSTOM_RULES_B64:-}"

# ── Select and prepare capture interfaces ───────────────────────────────────────
# Suricata is attached to multiple Docker bridge networks (ot-net, control-net,
# internet-dmz-net, attacker-net). Without promiscuous mode, the Linux kernel only
# delivers frames addressed to this container's own MAC. Promiscuous mode makes the
# bridge deliver ALL frames so Suricata can inspect every packet on each segment.

IFACES=()
CLUSTER_ID=1

if [ -n "${SURICATA_IFACE:-}" ]; then
    # Explicit single-interface override (useful for unit tests or non-host-mode deployments)
    ip link set "$SURICATA_IFACE" promisc on 2>/dev/null \
        && echo "[ics-suricata] Promiscuous mode enabled on ${SURICATA_IFACE}" \
        || echo "[ics-suricata] Warning: could not set promisc on ${SURICATA_IFACE}"
    IFACES=("$SURICATA_IFACE")
else
    # Running in host network mode: detect Docker bridge interfaces (br-XXXX) that carry
    # simulation traffic. Docker creates a br-XXXX Linux bridge on the host for each
    # network; the host-side bridge sees ALL inter-container unicast frames, unlike a
    # container veth which only receives frames addressed to its own MAC.
    #
    # Selection criteria:
    #   1. Interface has a "bridge" kernel type (directory /sys/class/net/<iface>/bridge exists)
    #   2. Interface has an address in 10.200.x.x (our simulation subnet range)
    #
    # We do NOT set promiscuous mode on bridge interfaces — the bridge already receives
    # all frames from its member ports. Promisc on br-XXXX is a no-op for capture purposes.
    for candidate in $(ls /sys/class/net/ 2>/dev/null | sort); do
        if [ -d "/sys/class/net/${candidate}/bridge" ] 2>/dev/null; then
            if ip addr show "$candidate" 2>/dev/null | grep -qE 'inet 10\.200\.'; then
                echo "[ics-suricata] Found simulation bridge: ${candidate}"
                IFACES+=("$candidate")
            fi
        fi
    done
    if [ ${#IFACES[@]} -eq 0 ]; then
        # Fallback: no bridge interfaces found — may be running outside host-network mode.
        # Fall back to scanning all non-loopback interfaces with a 10.x address (old behaviour).
        echo "[ics-suricata] Warning: no br-XXXX bridge interfaces found, falling back to veth scan"
        for candidate in $(ls /sys/class/net/ 2>/dev/null | grep -v lo | sort); do
            if ip addr show "$candidate" 2>/dev/null | grep -qE 'inet 10\.'; then
                ip link set "$candidate" promisc on 2>/dev/null
                IFACES+=("$candidate")
            fi
        done
    fi
    if [ ${#IFACES[@]} -eq 0 ]; then
        echo "[ics-suricata] Warning: no suitable interface found, falling back to eth0"
        IFACES=("eth0")
    fi
fi

echo "[ics-suricata] Device=${DEVICE_ID}  interfaces=${IFACES[*]}"

# ── Write af-packet config to a separate include file ───────────────────────────
# Writing to a SEPARATE file (not appending to otforge.yaml) prevents the af-packet
# block from accumulating on each Docker restart. Docker's restart policy re-uses the
# same container filesystem, so >> appends would add a duplicate af-packet section on
# every crash-restart cycle, triggering "Configuration node 'af-packet' redefined"
# warnings and eventually corrupting the config.
#
# Using > (overwrite) on a dedicated file makes the entrypoint idempotent across
# restarts. Suricata loads it via --include on the CLI.
#
# Each interface gets a unique cluster-id so the kernel delivers frame copies to
# separate AF_PACKET sockets. cluster_flow hashing ensures all packets of a given
# TCP/UDP flow land on the same worker thread for correct stream reassembly.
AF_PACKET_CONF="/etc/suricata/af-packet.yaml"
{
    # Suricata requires all included config files to begin with the YAML 1.1 header
    printf "%%YAML 1.1\n---\n"
    printf "af-packet:\n"
    for iface in "${IFACES[@]}"; do
        printf "  - interface: %s\n"    "$iface"
        printf "    cluster-id: %d\n"   "$CLUSTER_ID"
        printf "    cluster-type: cluster_flow\n"
        printf "    defrag: yes\n"
        CLUSTER_ID=$((CLUSTER_ID + 1))
    done
} > "$AF_PACKET_CONF"

echo "[ics-suricata] Enabled rulesets: ${RULESETS}"
[ -n "$DISABLED_SIDS" ] && echo "[ics-suricata] Suppressed SIDs: ${DISABLED_SIDS}"

# ── Generate SID suppression file ───────────────────────────────────────────────
# Suricata reads threshold.conf at startup. Each suppress entry tells the engine to
# load the rule (so rule counts are accurate) but never emit an alert for that SID.
# This is preferable to disabling rules entirely because it keeps the ruleset complete
# while silencing known lab false-positives.
THRESHOLD_FILE="/etc/suricata/threshold.conf"
# Start with an empty threshold file so old suppression entries don't persist
> "$THRESHOLD_FILE"

if [ -n "$DISABLED_SIDS" ]; then
    for sid in $(echo "$DISABLED_SIDS" | tr ',' ' '); do
        sid_clean=$(echo "$sid" | tr -d '[:space:]')
        if [ -n "$sid_clean" ]; then
            # gen_id 1 = all standard ET rules; sig_id = the specific rule SID
            echo "suppress gen_id 1, sig_id ${sid_clean}" >> "$THRESHOLD_FILE"
            echo "[ics-suricata] Suppressing SID ${sid_clean}"
        fi
    done
fi

# ── Write custom rules ──────────────────────────────────────────────────────────
# IDS_CUSTOM_RULES_B64 carries base64-encoded Suricata rule text authored in the
# OTForge IDSPanel. Decoded to custom.rules so Suricata loads it on startup.
# The rule-files list in otforge.yaml always includes this path; when no custom
# rules are set, an empty file satisfies the include without generating errors.
CUSTOM_RULES_FILE="/etc/suricata/rules/custom.rules"
if [ -n "${CUSTOM_RULES_B64}" ]; then
    echo "[ics-suricata] Decoding custom rules → ${CUSTOM_RULES_FILE}"
    echo "${CUSTOM_RULES_B64}" | base64 -d > "${CUSTOM_RULES_FILE}"
    # The rule count is logged after validation below, not here — counting before
    # validation reported "1 rule(s) loaded" for rules Suricata then refused to load.
else
    # Create an empty file so the rule-files entry in otforge.yaml is always satisfied
    > "${CUSTOM_RULES_FILE}"
    echo "[ics-suricata] No custom rules — ${CUSTOM_RULES_FILE} is empty"
fi

# ── Ensure suricata.rules placeholder exists ────────────────────────────────────
# The rule-files list in otforge.yaml includes /var/lib/suricata/rules/suricata.rules,
# which is populated by suricata-update (run in the background below). On the first
# start the file does not yet exist, and --init-errors-fatal treats a missing rule file
# as a fatal init error, killing Suricata immediately before it can capture any traffic.
# Creating an empty placeholder satisfies the rule-files list so Suricata starts with
# only our bundled otforge.rules. suricata-update will overwrite this file with the
# full Emerging Threats ruleset once it completes; the rules take effect on next restart.
SURICATA_RULES="/var/lib/suricata/rules/suricata.rules"
if [ ! -f "$SURICATA_RULES" ]; then
    mkdir -p "$(dirname "$SURICATA_RULES")"
    touch "$SURICATA_RULES"
    echo "[ics-suricata] Created empty placeholder: ${SURICATA_RULES}"
fi

# ── Validate custom rules before starting ───────────────────────────────────────
# Suricata runs with --init-errors-fatal under `restart: unless-stopped`, so a single
# malformed custom rule used to kill the sensor at init on every restart, forever.
# Nothing in the app showed it: the student just saw "no alerts", which looks the
# same as "the attack didn't work". A multi-line rule cost a student days this way.
#
# Fix: dry-run the config with `suricata -T` (test mode, ~0.1 s) BEFORE the real
# start. For every custom rule it rejects, Suricata prints the reason, then
#   error parsing signature "..." from file /etc/suricata/rules/custom.rules at line N
# We comment out exactly those lines (keeping the good rules), record why in a report
# file, and start the sensor with what remains. A typo now costs one rule, not the IDS.
#
# Report: /var/log/suricata/custom-rules-rejected.txt (shared log volume). Absent when
# every custom rule loaded.
REJECTED_REPORT="/var/log/suricata/custom-rules-rejected.txt"
rm -f "$REJECTED_REPORT"

# Test-only overlay: narrows rule-files to the bundled OTForge rules + custom rules.
# Without it, once suricata-update has downloaded the Emerging Threats set (~53k
# rules), every test pass takes ~22 s instead of ~0.1 s (measured, Suricata 8.0.7).
# The one check this skips — a custom sid colliding with a downloaded ET rule — is
# done separately below with a grep.
VALIDATE_CONF="/tmp/suricata-test/validate.yaml"
mkdir -p /tmp/suricata-test
printf '%%YAML 1.1\n---\nrule-files:\n  - /etc/suricata/rules/otforge.rules\n  - %s\n' \
    "$CUSTOM_RULES_FILE" > "$VALIDATE_CONF"

# Runs Suricata's config/rule test with the real config plus the overlay above.
# Prints the combined test output; returns Suricata's exit status (0 = all loaded).
run_rule_test() {
    suricata -T \
        -c /etc/suricata/otforge.yaml \
        --include "$AF_PACKET_CONF" \
        --include "$VALIDATE_CONF" \
        --init-errors-fatal \
        -l /tmp/suricata-test 2>&1
}

# Prints the header of the rejection report once, on first use.
start_report() {
    if [ ! -f "$REJECTED_REPORT" ]; then
        {
            echo "OTForge rejected these custom Suricata rules at sensor start."
            echo "The sensor is running WITHOUT them. Fix each rule in the IDS panel"
            echo "and restart the simulation."
            echo
        } > "$REJECTED_REPORT"
    fi
}

# Logs one rejected rule to the container log and the report, then comments the
# line out in place so the real start skips it. sed's line address keeps every
# other line number stable, so several lines can be rejected in one pass.
#   $1 = line number in custom.rules   $2 = reason   $3 = optional hint
reject_rule() {
    local lineno="$1" reason="$2" hint="${3:-}"
    local rule_text
    rule_text=$(sed -n "${lineno}p" "$CUSTOM_RULES_FILE")
    start_report
    echo "[ics-suricata]   line ${lineno}: ${reason}"
    echo "[ics-suricata]     ${rule_text}"
    [ -n "$hint" ] && echo "[ics-suricata]     ${hint}"
    {
        echo "Line ${lineno}: ${reason}"
        echo "  ${rule_text}"
        [ -n "$hint" ] && echo "  ${hint}"
        echo
    } >> "$REJECTED_REPORT"
    sed -i "${lineno}s/^/# REJECTED: /" "$CUSTOM_RULES_FILE"
}

DUP_SID_HINT="Hint: every rule needs a unique sid. This sid is already used by another loaded rule (custom or bundled)."

if [ -s "$CUSTOM_RULES_FILE" ]; then
    test_rc=0
    test_out=$(run_rule_test) || test_rc=$?

    if [ "$test_rc" -ne 0 ]; then
        # Pair each "at line N" error with the reason line Suricata printed just
        # before it. Output is one "N<TAB>reason" record per rejected custom rule.
        bad_lines=$(printf '%s\n' "$test_out" | awk -v f="$CUSTOM_RULES_FILE" '
            /error parsing signature/ && index($0, "from file " f " at line ") {
                n = $0; sub(/.* at line /, "", n); sub(/[^0-9].*/, "", n)
                print n "\t" reason
                next
            }
            /^Error: / { reason = $0; sub(/^Error: [^:]*: /, "", reason) }
        ')

        if [ -n "$bad_lines" ]; then
            echo "[ics-suricata] ================================================================"
            echo "[ics-suricata] CUSTOM RULE ERROR - these rules were NOT loaded:"
            while IFS=$'\t' read -r lineno reason; do
                # "no rule options" almost always means the rule was split across
                # lines: Suricata ends a rule at the line break, so only the header
                # (action, protocol, addresses) reached the parser.
                hint=""
                case "$reason" in
                    *"no rule options"*)
                        hint="Hint: a rule ends at the line break, so its options in (...) never reached the parser. Put the rule on one line, or end each wrapped line with a backslash (\)." ;;
                    *"Duplicate signature"*)
                        hint="$DUP_SID_HINT" ;;
                esac
                reject_rule "$lineno" "$reason" "$hint"
            done <<< "$bad_lines"
            echo "[ics-suricata] Details: ${REJECTED_REPORT}"
            echo "[ics-suricata] ================================================================"

            # Re-test with the bad lines removed.
            test_rc=0
            test_out=$(run_rule_test) || test_rc=$?
        fi

        if [ "$test_rc" -ne 0 ]; then
            # Still failing, and Suricata didn't tie the error to a specific custom
            # rule line. Last resort: set ALL custom rules aside and test once more,
            # so the sensor at least runs on the bundled rules.
            echo "[ics-suricata] Rule test still failing - setting ALL custom rules aside:"
            printf '%s\n' "$test_out" | grep '^Error' | sed 's/^/[ics-suricata]   /'
            cp "$CUSTOM_RULES_FILE" "${CUSTOM_RULES_FILE}.rejected"
            > "$CUSTOM_RULES_FILE"
            {
                echo "OTForge set ALL custom Suricata rules aside: the rule test failed"
                echo "and the error could not be traced to a single rule line."
                echo
                printf '%s\n' "$test_out" | grep '^Error'
            } >> "$REJECTED_REPORT"

            test_rc=0
            test_out=$(run_rule_test) || test_rc=$?
            if [ "$test_rc" -ne 0 ]; then
                # Not a custom-rule problem (bundled rules or config). Show the real
                # error and let the start below fail as it would have before.
                echo "[ics-suricata] Rule test fails even without custom rules - config or bundled-rule error:"
                printf '%s\n' "$test_out" | grep '^Error' | sed 's/^/[ics-suricata]   /'
            fi
        fi
    fi

    # The fast test above leaves out the downloaded Emerging Threats rules, so check
    # that no surviving custom rule reuses an ENABLED ET rule's sid (a duplicate would
    # still kill the real start). Disabled ET rules are written commented out ("# alert
    # ..."), so anchoring on a leading action keyword skips them. A grep of the ~30 MB
    # file per rule takes milliseconds, versus ~22 s to parse it with suricata -T.
    if [ -s "$SURICATA_RULES" ]; then
        while read -r lineno sid; do
            if grep -qE "^(alert|drop|pass|reject|rejectsrc|rejectdst|rejectboth)[[:space:]].*[(; ]sid:[[:space:]]*${sid}[[:space:]]*;" \
                "$SURICATA_RULES"; then
                reject_rule "$lineno" "sid ${sid} is already used by a downloaded Emerging Threats rule" "$DUP_SID_HINT"
            fi
        done < <(awk '
            /^(alert|drop|pass|reject|rejectsrc|rejectdst|rejectboth)[ \t]/ &&
            match($0, /[(; ]sid:[ \t]*[0-9]+/) {
                s = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", s)
                print NR, s
            }' "$CUSTOM_RULES_FILE")
    fi

    # Count the rules that actually survived validation (commented-out lines don't match).
    rule_count=$(grep -cE '^(alert|drop|pass|reject|rejectsrc|rejectdst|rejectboth)\s' \
        "${CUSTOM_RULES_FILE}" 2>/dev/null || true)
    echo "[ics-suricata] Custom rules loaded: ${rule_count:-0} rule(s)"
fi

# ── Update rulesets (non-blocking background job) ────────────────────────────────
# suricata-update downloads and merges Emerging Threats Open rules.
# Runs in the background so Suricata starts immediately with the bundled otforge.rules.
# If suricata-update succeeds, the new suricata.rules takes effect on next restart.

# Write enable.conf so suricata-update only downloads selected rulesets.
ENABLE_CONF="/var/lib/suricata/update/enable.conf"
mkdir -p "$(dirname "$ENABLE_CONF")"
> "$ENABLE_CONF"
for rs in $(echo "$RULESETS" | tr ',' ' '); do
    rs_clean=$(echo "$rs" | tr -d '[:space:]')
    [ -n "$rs_clean" ] && echo "$rs_clean" >> "$ENABLE_CONF"
done

echo "[ics-suricata] Launching suricata-update in background (non-blocking)..."
(
    suricata-update \
        --no-reload \
        --no-test \
        --suricata-conf /etc/suricata/otforge.yaml \
        2>/dev/null \
    && echo "[ics-suricata] Background rule update complete" \
    || echo "[ics-suricata] Background rule update failed or offline — bundled rules active"
) &
disown $!

# ── Start Suricata ──────────────────────────────────────────────────────────────
# --af-packet (no argument) activates AF_PACKET capture mode in Suricata 8+.
# Interface definitions come from the af-packet.yaml include file written above
# rather than appended to otforge.yaml, so the config stays clean across restarts.
# Eve JSON output goes to /var/log/suricata/ (named volume shared with Promtail).
echo "[ics-suricata] Starting Suricata in AF_PACKET mode on ${IFACES[*]}..."
exec suricata \
    --af-packet \
    -c /etc/suricata/otforge.yaml \
    --include "$AF_PACKET_CONF" \
    --init-errors-fatal \
    -l /var/log/suricata
