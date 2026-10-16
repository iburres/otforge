/**
 * unpack.ts — Step 1 of the fw-analyzer pipeline: firmware image → extracted rootfs.
 *
 * Takes a firmware image on disk, runs unblob inside the otforge-fw-analyzer
 * container (containers/fw-analyzer), and lays the result out under a per-image
 * working directory:
 *
 *   findings-out/<id>/
 *     extract/              full unblob extraction tree (kernel, rootfs, carved chunks)
 *     unblob-report.json    unblob's own chunk/hash/magic report
 *     unblob.log            unblob's log (verbose; internal probe errors are normal)
 *     unpack.json           OUR manifest — what later steps (sbom.ts) read
 *
 * The manifest lists every directory that looks like a Linux root filesystem
 * (`rootfsDirs`). We record paths instead of moving a single dir to `rootfs/`
 * because real images can carry several (main + recovery/factory), and the
 * kernel image the SBOM step wants for its version banner lives outside the
 * rootfs. Bare-metal/RTOS firmware — common in PLCs — legitimately has none,
 * so an empty list is a warning, not an error.
 *
 * Security posture: firmware is untrusted input. The container runs with no
 * network, all capabilities dropped, no-new-privileges, and the image mounted
 * read-only under a fixed name (so odd vendor filenames never reach a shell
 * or the container command line). Docker is invoked with execFile-style
 * argument arrays — no shell string is ever built.
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

/** Docker image built from containers/fw-analyzer and published by docker.yml. */
export const DEFAULT_ANALYZER_IMAGE = 'ghcr.io/iburres/otforge-fw-analyzer:latest'

/** Fixed in-container path for the firmware; see the security note above. */
const CONTAINER_INPUT = '/data/input/firmware.bin'

/** unblob's output mount; matches the upstream image's WORKDIR. */
const CONTAINER_OUTPUT = '/data/output'

/**
 * Directory names that, alongside `etc/`, mark a Linux root filesystem.
 * Requiring `etc` plus at least one of these avoids false positives on
 * random config bundles that merely contain an `etc/` folder.
 */
const ROOTFS_MARKERS = ['bin', 'sbin', 'lib', 'usr']

/** Result of one external command. */
export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Runs an external command. Injected so unit tests can fake Docker; the
 * default (`spawnRunner`) is a thin promise wrapper around child_process.spawn.
 */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

/** Inputs to {@link unpackFirmware}. */
export interface UnpackOptions {
  /** Path to the firmware image to unpack. */
  imagePath: string
  /** Root output directory — normally `<repo>/findings-out` (gitignored). */
  outRoot: string
  /** Override the analysis id; defaults to the first 16 hex chars of the image SHA-256. */
  id?: string
  /** Delete an existing `<outRoot>/<id>/` instead of refusing to overwrite it. */
  force?: boolean
  /** Analyzer container image; defaults to {@link DEFAULT_ANALYZER_IMAGE}. */
  dockerImage?: string
  /** Command runner; defaults to {@link spawnRunner}. */
  runner?: CommandRunner
  /** Clock, injectable for deterministic tests. */
  now?: () => Date
}

/** The `unpack.json` manifest consumed by later pipeline steps. */
export interface UnpackManifest {
  /** Bumped if the manifest shape changes incompatibly. */
  schemaVersion: 1
  /** Analysis id — also the directory name under outRoot. */
  id: string
  /** Facts about the input image. */
  image: {
    fileName: string
    sizeBytes: number
    sha256: string
  }
  /** Toolchain provenance so a finding can be reproduced later. */
  tool: {
    dockerImage: string
    /** Local image ID (sha256:…) actually used, or null if docker inspect failed. */
    dockerImageId: string | null
  }
  /** Paths below are relative to the working directory, POSIX separators. */
  extractDir: string
  /** Every directory that looks like a Linux rootfs, shallowest first. */
  rootfsDirs: string[]
  unblobReport: string
  unblobLog: string
  /** Non-fatal problems a reviewer should know about. */
  warnings: string[]
  startedAt: string
  finishedAt: string
}

/** What {@link unpackFirmware} returns: the manifest plus the absolute working dir. */
export interface UnpackResult {
  workDir: string
  manifest: UnpackManifest
}

/**
 * Default {@link CommandRunner}: spawns without a shell and buffers output.
 * unblob is chatty, so only the last 64 KiB of each stream is kept — enough
 * for an error message, without letting a huge log balloon process memory.
 */
export const spawnRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true })
    const LIMIT = 64 * 1024
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(-LIMIT)
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-LIMIT)
    })
    // 'error' fires when the binary itself can't start (e.g. Docker not installed).
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })

/** Streams a file through SHA-256 so multi-GB images never load into memory. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Builds the `docker run` argument list for one unblob extraction.
 * Exported for tests — the hardening flags here are a security property
 * worth asserting, not an implementation detail.
 *
 * @param imageAbs   absolute host path of the firmware image
 * @param workDirAbs absolute host path of the per-image working directory
 * @param dockerImage analyzer image reference
 */
export function buildDockerArgs(
  imageAbs: string,
  workDirAbs: string,
  dockerImage: string
): string[] {
  const args = [
    'run',
    '--rm',
    // Untrusted input: no network, no capabilities, no privilege escalation,
    // and a PID cap so a pathological archive can't fork-bomb the host.
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512'
  ]
  // On Linux/macOS bind mounts keep host ownership, so run as the caller's
  // uid/gid — otherwise the container's uid 1000 may be unable to write the
  // output dir, or leave root-owned files the user can't delete. Docker
  // Desktop on Windows maps ownership itself, and process.getuid is absent.
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`)
  }
  args.push(
    '-v',
    `${imageAbs}:${CONTAINER_INPUT}:ro`,
    '-v',
    `${workDirAbs}:${CONTAINER_OUTPUT}`,
    dockerImage,
    // Everything after the image name is passed to the `unblob` entrypoint.
    '--report',
    `${CONTAINER_OUTPUT}/unblob-report.json`,
    '--log',
    `${CONTAINER_OUTPUT}/unblob.log`,
    '--extract-dir',
    `${CONTAINER_OUTPUT}/extract`,
    CONTAINER_INPUT
  )
  return args
}

/**
 * Recursively finds directories that look like a Linux root filesystem
 * (`etc/` plus one of {@link ROOTFS_MARKERS}). Once a directory matches we do
 * not descend into it, so `rootfs/usr/...` can't be reported as a second
 * rootfs. Symlinks are never followed — extracted firmware routinely contains
 * absolute or looping links that would escape the extraction tree.
 *
 * @param baseDir directory to search
 * @returns absolute paths, shallowest first, then alphabetically
 */
export async function findRootfsDirs(baseDir: string): Promise<string[]> {
  const found: string[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    // isDirectory() on a Dirent is false for symlinks, which is what we want.
    const subdirs = entries.filter(e => e.isDirectory()).map(e => e.name)
    const names = new Set(subdirs)
    if (names.has('etc') && ROOTFS_MARKERS.some(m => names.has(m))) {
      found.push(dir)
      return
    }
    for (const name of subdirs) {
      await walk(path.join(dir, name))
    }
  }

  await walk(baseDir)
  const depth = (p: string): number => p.split(path.sep).length
  return found.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
}

/** True if the path exists (file or dir). */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Deletes an analysis working directory (`<outRoot>/<id>`).
 *
 * Why this isn't just fs.rm: on Windows, Docker Desktop materialises the
 * firmware's Linux symlinks as NTFS junctions. Relative links such as
 * OpenWrt's `var -> tmp` become junctions with a relative target, which
 * Windows does not support — Node can't even lstat them (EACCES/EPERM), so
 * fs.rm fails partway. When that happens we delete the tree from the Linux
 * side instead, using the same hardened analyzer container.
 *
 * @param workDir     absolute path of the directory to delete
 * @param dockerImage analyzer image (provides `rm`)
 * @param runner      command runner
 * @throws if the directory still exists after both attempts
 */
export async function removeAnalysisDir(
  workDir: string,
  dockerImage: string = DEFAULT_ANALYZER_IMAGE,
  runner: CommandRunner = spawnRunner
): Promise<void> {
  try {
    await rm(workDir, { recursive: true, force: true })
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES') throw err
  }

  // Mount the PARENT so the container can remove the directory itself, and
  // target it by basename — never an arbitrary host path on the rm command line.
  const parent = path.dirname(workDir)
  const name = path.basename(workDir)
  const args = [
    'run',
    '--rm',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges'
  ]
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`)
  }
  args.push('-v', `${parent}:/work`, '--entrypoint', 'rm', dockerImage, '-rf', `/work/${name}`)
  const result = await runner('docker', args)
  if (result.code !== 0 || (await exists(workDir))) {
    throw new Error(
      `Could not delete ${workDir}: ${result.stderr.trim() || 'directory still present'}`
    )
  }
}

/** Converts an absolute path under workDir to the manifest's relative POSIX form. */
function rel(workDir: string, p: string): string {
  return path.relative(workDir, p).split(path.sep).join('/')
}

/**
 * Unpacks one firmware image. See the file header for the output layout.
 *
 * @throws if the image is missing/not a file, the working dir already exists
 *         (without `force`), Docker can't be started, or unblob exits non-zero.
 */
export async function unpackFirmware(opts: UnpackOptions): Promise<UnpackResult> {
  const runner = opts.runner ?? spawnRunner
  const now = opts.now ?? (() => new Date())
  const dockerImage = opts.dockerImage ?? DEFAULT_ANALYZER_IMAGE
  const startedAt = now().toISOString()

  // ── Validate input ─────────────────────────────────────────────────────────
  const imageAbs = path.resolve(opts.imagePath)
  let imageStat
  try {
    imageStat = await stat(imageAbs)
  } catch {
    throw new Error(`Firmware image not found: ${imageAbs}`)
  }
  if (!imageStat.isFile()) {
    throw new Error(`Firmware image is not a regular file: ${imageAbs}`)
  }

  // ── Derive id + working dir ────────────────────────────────────────────────
  // Hash-derived ids make re-runs land in the same place and keep vendor/model
  // names out of directory names (findings-out may be shared or screenshotted).
  const sha256 = await sha256File(imageAbs)
  const id = opts.id ?? sha256.slice(0, 16)
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Invalid analysis id "${id}" — use letters, digits, dot, dash, underscore`)
  }
  const workDir = path.join(path.resolve(opts.outRoot), id)

  if (await exists(workDir)) {
    if (!opts.force) {
      throw new Error(`Output already exists: ${workDir} (pass force to overwrite)`)
    }
    await removeAnalysisDir(workDir, dockerImage, runner)
  }
  await mkdir(workDir, { recursive: true })

  // ── Run unblob in the container ────────────────────────────────────────────
  const result = await runner('docker', buildDockerArgs(imageAbs, workDir, dockerImage))
  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout).trim().split('\n').slice(-15).join('\n')
    throw new Error(`unblob container exited with code ${result.code}:\n${tail}`)
  }

  const extractDir = path.join(workDir, 'extract')
  if (!(await exists(extractDir))) {
    throw new Error(`unblob reported success but produced no extraction directory at ${extractDir}`)
  }

  // ── Record provenance + locate rootfs ──────────────────────────────────────
  // Image ID pins the exact toolchain even though we invoke a mutable tag.
  const inspect = await runner('docker', ['image', 'inspect', '--format', '{{.Id}}', dockerImage])
  const dockerImageId = inspect.code === 0 ? inspect.stdout.trim() || null : null

  const warnings: string[] = []
  const rootfsAbs = await findRootfsDirs(extractDir)
  if (rootfsAbs.length === 0) {
    warnings.push(
      'No Linux root filesystem found. The image may be bare-metal/RTOS, encrypted, or use a format unblob does not support.'
    )
  }

  const manifest: UnpackManifest = {
    schemaVersion: 1,
    id,
    image: { fileName: path.basename(imageAbs), sizeBytes: imageStat.size, sha256 },
    tool: { dockerImage, dockerImageId },
    extractDir: rel(workDir, extractDir),
    rootfsDirs: rootfsAbs.map(p => rel(workDir, p)),
    unblobReport: 'unblob-report.json',
    unblobLog: 'unblob.log',
    warnings,
    startedAt,
    finishedAt: now().toISOString()
  }
  await writeFile(
    path.join(workDir, 'unpack.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8'
  )

  return { workDir, manifest }
}
