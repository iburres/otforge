FROM jasonish/suricata:latest

# Apply AlmaLinux security updates on top of the upstream image. Until 2026-10-07
# this image had no package layer of its own, so a CVE fixed in the Alma repos stayed
# in the image until jasonish/suricata itself was rebuilt, and the Trivy gate in
# docker.yml went red with nothing to rebuild.
#
# SECURITY_REFRESH busts this layer's build cache so a rebuild re-runs the upgrade
# against the *current* Alma repos instead of reusing an old cached layer (same
# pattern as containers/zeek and containers/workstation). Bump the date whenever a
# newly published security update needs to be pulled.
# 2026-10-07: curl/libcurl-minimal (CVE-2026-8458, -8927), expat (CVE-2026-66046,
# -93990), gdb-gdbserver (CVE-2026-13732), libevent (CVE-2026-63379), libpcap
# (CVE-2026-0799), libxml2 (CVE-2026-74860): 22 HIGH findings, all with fixed
# el9_8 packages, flagged by the Trivy scan after PR #86 republished this image.
ARG SECURITY_REFRESH=2026-10-07
RUN echo "security-refresh: ${SECURITY_REFRESH}" \
    && dnf -y upgrade --refresh \
    && dnf clean all \
    && rm -rf /var/cache/dnf

# CVE-2026-58016 (glib2, HIGH) is suppressed in the root .trivyignore — it's
# baked into this upstream base image (no apt/dnf layer of our own to patch
# it with) and isn't fixed in jasonish/suricata:latest yet as of 2026-07-21.

# ICS/OT-specific rules — loaded by the rule-files list in otforge.yaml
COPY ics-rules.rules /etc/suricata/rules/otforge.rules

# Suricata overlay config — sets HOME_NET, enables Modbus/DNP3 decoders,
# configures EVE JSON output, and lists rule files. The entrypoint passes
# -c /etc/suricata/otforge.yaml so this file must be at exactly this path.
COPY suricata.yaml /etc/suricata/otforge.yaml

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# DEVICE_ID is overridden at runtime via compose environment.
# SURICATA_IFACE is intentionally NOT set here — leaving it unset triggers the
# multi-interface auto-detection logic in entrypoint.sh, which discovers every
# 10.x interface (ot-net, control-net, internet-dmz-net, attacker-net) and
# starts one AF_PACKET worker per bridge. Set SURICATA_IFACE in compose to
# force single-interface mode (e.g., for unit testing).
ENV DEVICE_ID=suricata-1

ENTRYPOINT ["/entrypoint.sh"]
