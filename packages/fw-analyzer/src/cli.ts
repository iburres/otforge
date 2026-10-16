#!/usr/bin/env node
/**
 * cli.ts — command-line entry point for fw-analyzer.
 *
 * Usage (from the repo root, after `npm run build:packages`):
 *   npm run fw -- unpack <firmware-image> [--out <dir>] [--id <id>] [--force]
 *
 * --out defaults to <repo>/findings-out, which is gitignored so extracted
 * vendor firmware can never be committed by accident.
 */

import * as path from 'node:path'
import { unpackFirmware } from './unpack'

/** <repo>/findings-out, resolved from dist/cli.js → packages/fw-analyzer/dist. */
const DEFAULT_OUT = path.resolve(__dirname, '..', '..', '..', 'findings-out')

const USAGE = 'Usage: otforge-fw unpack <firmware-image> [--out <dir>] [--id <id>] [--force]'

/** Parses argv, runs the requested sub-command, returns a process exit code. */
async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'unpack') {
    console.error(USAGE)
    return 2
  }

  // Minimal flag parser: one positional (the image) plus three flags.
  let imagePath: string | undefined
  let outRoot = DEFAULT_OUT
  let id: string | undefined
  let force = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--force') force = true
    else if (arg === '--out') outRoot = rest[++i] ?? ''
    else if (arg === '--id') id = rest[++i]
    else if (arg !== undefined && !arg.startsWith('--') && imagePath === undefined) imagePath = arg
    else {
      console.error(`Unknown argument: ${arg}\n${USAGE}`)
      return 2
    }
  }
  if (!imagePath || !outRoot) {
    console.error(USAGE)
    return 2
  }

  console.log(`Unpacking ${imagePath} (this runs unblob in Docker and can take a few minutes)…`)
  const { workDir, manifest } = await unpackFirmware({
    imagePath,
    outRoot,
    force,
    ...(id !== undefined ? { id } : {})
  })
  console.log(`id:        ${manifest.id}`)
  console.log(`sha256:    ${manifest.image.sha256}`)
  console.log(`output:    ${workDir}`)
  console.log(
    `rootfs:    ${manifest.rootfsDirs.length ? manifest.rootfsDirs.join('\n           ') : '(none)'}`
  )
  for (const w of manifest.warnings) console.warn(`warning:   ${w}`)
  return 0
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
)
