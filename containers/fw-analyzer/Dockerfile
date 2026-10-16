# ─────────────────────────────────────────────────────────────────────────────
# otforge-fw-analyzer — firmware unpack toolchain for packages/fw-analyzer.
#
# Why a container: unblob depends on a long tail of native extractors
# (sasquatch for vendor-patched SquashFS, jefferson for JFFS2, ubireader,
# 7z, lz4, zstd, …). Packaging them here means students only need Docker,
# never a per-OS install of a dozen unpackers.
#
# Base: the upstream unblob image (Debian bookworm, amd64 + arm64), pinned by
# tag AND digest so a re-pushed tag can never silently change the toolchain.
# It already runs as the non-root `unblob` user (uid 1000) with entrypoint
# `unblob`, writing to /data/output — we keep all three.
#
# Runtime hardening is applied by the caller (packages/fw-analyzer/src/unpack.ts):
# --network none, --cap-drop ALL, no-new-privileges, firmware mounted read-only.
# Firmware is untrusted input; the extractor should never see the network.
# ─────────────────────────────────────────────────────────────────────────────
FROM ghcr.io/onekey-sec/unblob:25.11.25@sha256:29a62a56fe6de1a8043b1d92075a966be1cef3d8e8e637f10ef45ab7f4f0a241

LABEL org.opencontainers.image.title="otforge-fw-analyzer" \
      org.opencontainers.image.description="Firmware unpack toolchain (unblob + extractors) for OTForge fw-analyzer" \
      org.opencontainers.image.source="https://github.com/iburres/otforge" \
      org.opencontainers.image.licenses="MIT"

# Sanity-check at build time that the extractors unpack.ts relies on are present,
# so a broken upstream image fails CI here instead of mid-analysis on a student box.
RUN unblob --version && command -v sasquatch && command -v jefferson && command -v 7z
