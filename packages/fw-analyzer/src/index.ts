/**
 * @otforge/fw-analyzer — public API.
 *
 * Firmware analysis pipeline, built one step at a time:
 *   1. unpack.ts     firmware image → extracted rootfs   (this milestone)
 *   2. sbom.ts       rootfs → CycloneDX SBOM             (next)
 *   3. cve-match.ts  SBOM → NVD + CISA KEV matches
 *   4. report.ts     findings → draft advisory
 *
 * This package is pure tooling and lives in the PUBLIC repo. Firmware blobs
 * (firmware-in/) and analysis output (findings-out/) are gitignored; confirmed
 * pre-disclosure findings belong in the private OTForge-disclosures repo.
 */

export * from './unpack'
