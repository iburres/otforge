/**
 * unpack.test.ts — tests for step 1 of the fw-analyzer pipeline.
 *
 * Unit tests inject a fake CommandRunner that imitates unblob by writing a
 * small directory tree into the mounted output dir, so they run anywhere
 * (including CI) without Docker or real firmware.
 *
 * The end-to-end test at the bottom is OPT-IN: it runs the real container
 * against a real public image and only executes when FW_E2E_IMAGE points at
 * one, e.g. the OpenWrt 19.07.10 Archer C7 v2 sysupgrade image:
 *
 *   FW_E2E_IMAGE=../../firmware-in/openwrt-19.07.10/<file>.bin npm test
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildDockerArgs,
  CommandRunner,
  findRootfsDirs,
  removeAnalysisDir,
  sha256File,
  unpackFirmware,
  UnpackManifest
} from '../unpack'

/** SHA-256 of the 5-byte ASCII string "hello". */
const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

let tmp: string
let image: string
let outRoot: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'fw-unpack-'))
  image = path.join(tmp, 'fw.bin')
  outRoot = path.join(tmp, 'findings-out')
  await writeFile(image, 'hello')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** Creates empty directories (and parents) under a base path. */
async function mkdirs(base: string, rels: string[]): Promise<void> {
  for (const r of rels) await mkdir(path.join(base, r), { recursive: true })
}

/**
 * Fake runner: on `docker run`, finds the host side of the /data/output mount
 * and creates the given tree under <output>/extract, the way unblob would.
 * Records every call so tests can assert on the docker arguments.
 */
function fakeRunner(tree: string[], opts: { runCode?: number } = {}) {
  const calls: string[][] = []
  const runner: CommandRunner = async (_cmd, args) => {
    calls.push(args)
    if (args[0] === 'image') return { code: 0, stdout: 'sha256:abc123\n', stderr: '' }
    if (opts.runCode) return { code: opts.runCode, stdout: '', stderr: 'boom: unsupported format' }
    const outMount = args.find(a => a.endsWith(':/data/output'))
    if (!outMount) throw new Error('no output mount in docker args')
    const hostOut = outMount.slice(0, -':/data/output'.length)
    await mkdirs(path.join(hostOut, 'extract'), tree)
    return { code: 0, stdout: '', stderr: '' }
  }
  return { runner, calls }
}

/** A tree shaped like the real OpenWrt extraction (kernel + nested squashfs). */
const OPENWRT_LIKE = [
  'firmware.bin_extract/512-1605518.lzma_extract',
  'firmware.bin_extract/1605520-4450110.squashfs_v4_le_extract/bin',
  'firmware.bin_extract/1605520-4450110.squashfs_v4_le_extract/etc',
  'firmware.bin_extract/1605520-4450110.squashfs_v4_le_extract/lib',
  'firmware.bin_extract/1605520-4450110.squashfs_v4_le_extract/usr/lib',
  'firmware.bin_extract/1605520-4450110.squashfs_v4_le_extract/www'
]

describe('sha256File', () => {
  it('hashes file contents', async () => {
    expect(await sha256File(image)).toBe(HELLO_SHA256)
  })
})

describe('buildDockerArgs', () => {
  const args = buildDockerArgs('/host/fw.bin', '/host/out/abc', 'img:tag')

  it('isolates the untrusted extraction', () => {
    expect(args.join(' ')).toContain('--network none')
    expect(args.join(' ')).toContain('--cap-drop ALL')
    expect(args.join(' ')).toContain('--security-opt no-new-privileges')
    expect(args).toContain('--rm')
  })

  it('mounts the image read-only under a fixed name', () => {
    expect(args).toContain('/host/fw.bin:/data/input/firmware.bin:ro')
    expect(args).toContain('/host/out/abc:/data/output')
  })

  it('passes unblob options after the image name', () => {
    const i = args.indexOf('img:tag')
    expect(i).toBeGreaterThan(0)
    expect(args.slice(i + 1)).toEqual([
      '--report',
      '/data/output/unblob-report.json',
      '--log',
      '/data/output/unblob.log',
      '--extract-dir',
      '/data/output/extract',
      '/data/input/firmware.bin'
    ])
  })
})

describe('findRootfsDirs', () => {
  it('finds a nested rootfs and does not descend into it', async () => {
    await mkdirs(tmp, OPENWRT_LIKE)
    const found = await findRootfsDirs(path.join(tmp, 'firmware.bin_extract'))
    expect(found).toEqual([
      path.join(tmp, 'firmware.bin_extract/1605520-4450110.squashfs_v4_le_extract')
    ])
  })

  it('ignores a bare etc/ with no binary/library dirs', async () => {
    await mkdirs(tmp, ['cfg/etc/config'])
    expect(await findRootfsDirs(tmp)).toEqual([])
  })

  it('returns multiple rootfs (e.g. main + recovery) shallowest first', async () => {
    await mkdirs(tmp, ['a/b/recovery/etc', 'a/b/recovery/sbin', 'main/etc', 'main/usr'])
    const found = await findRootfsDirs(tmp)
    expect(found).toEqual([path.join(tmp, 'main'), path.join(tmp, 'a/b/recovery')])
  })
})

describe('unpackFirmware', () => {
  const fixedClock = () => new Date('2026-10-16T12:00:00.000Z')

  it('writes a manifest that locates the rootfs', async () => {
    const { runner, calls } = fakeRunner(OPENWRT_LIKE)
    const { workDir, manifest } = await unpackFirmware({
      imagePath: image,
      outRoot,
      runner,
      now: fixedClock
    })

    expect(manifest.id).toBe(HELLO_SHA256.slice(0, 16))
    expect(workDir).toBe(path.join(outRoot, manifest.id))
    expect(manifest.image).toEqual({ fileName: 'fw.bin', sizeBytes: 5, sha256: HELLO_SHA256 })
    expect(manifest.tool.dockerImageId).toBe('sha256:abc123')
    expect(manifest.extractDir).toBe('extract')
    expect(manifest.rootfsDirs).toEqual([
      'extract/firmware.bin_extract/1605520-4450110.squashfs_v4_le_extract'
    ])
    expect(manifest.warnings).toEqual([])
    expect(manifest.startedAt).toBe('2026-10-16T12:00:00.000Z')

    // The manifest on disk matches what was returned.
    const onDisk = JSON.parse(
      await readFile(path.join(workDir, 'unpack.json'), 'utf8')
    ) as UnpackManifest
    expect(onDisk).toEqual(manifest)

    // First call is the extraction, second records the image ID.
    expect(calls[0]?.[0]).toBe('run')
    expect(calls[1]).toEqual([
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      'ghcr.io/iburres/otforge-fw-analyzer:latest'
    ])
  })

  it('warns (not fails) when no rootfs is found — bare-metal/RTOS firmware', async () => {
    const { runner } = fakeRunner(['firmware.bin_extract/0-4096.unknown_chunks'])
    const { manifest } = await unpackFirmware({ imagePath: image, outRoot, runner })
    expect(manifest.rootfsDirs).toEqual([])
    expect(manifest.warnings[0]).toMatch(/No Linux root filesystem/)
  })

  it('honours a custom id', async () => {
    const { runner } = fakeRunner(OPENWRT_LIKE)
    const { manifest } = await unpackFirmware({
      imagePath: image,
      outRoot,
      runner,
      id: 'openwrt-c7'
    })
    expect(manifest.id).toBe('openwrt-c7')
  })

  it('rejects ids that could escape outRoot', async () => {
    const { runner } = fakeRunner(OPENWRT_LIKE)
    await expect(
      unpackFirmware({ imagePath: image, outRoot, runner, id: '../evil' })
    ).rejects.toThrow(/Invalid analysis id/)
  })

  it('refuses to overwrite an existing analysis unless forced', async () => {
    await unpackFirmware({ imagePath: image, outRoot, runner: fakeRunner(OPENWRT_LIKE).runner })
    await expect(
      unpackFirmware({ imagePath: image, outRoot, runner: fakeRunner(OPENWRT_LIKE).runner })
    ).rejects.toThrow(/already exists/)
    const { manifest } = await unpackFirmware({
      imagePath: image,
      outRoot,
      runner: fakeRunner(OPENWRT_LIKE).runner,
      force: true
    })
    expect(manifest.rootfsDirs).toHaveLength(1)
  })

  it('throws on a missing image', async () => {
    await expect(
      unpackFirmware({
        imagePath: path.join(tmp, 'nope.bin'),
        outRoot,
        runner: fakeRunner([]).runner
      })
    ).rejects.toThrow(/not found/)
  })

  it('surfaces unblob failures with stderr', async () => {
    const { runner } = fakeRunner([], { runCode: 1 })
    await expect(unpackFirmware({ imagePath: image, outRoot, runner })).rejects.toThrow(
      /exited with code 1:\nboom: unsupported format/
    )
  })
})

// ── Opt-in end-to-end: real Docker, real public firmware ─────────────────────
const E2E_IMAGE = process.env['FW_E2E_IMAGE']

describe.skipIf(!E2E_IMAGE)('unpackFirmware (e2e, real container)', () => {
  it('extracts a real OpenWrt rootfs, re-runs with force, and cleans up', async () => {
    const { workDir, manifest } = await unpackFirmware({ imagePath: E2E_IMAGE as string, outRoot })
    expect(manifest.rootfsDirs.length).toBeGreaterThanOrEqual(1)
    expect(manifest.tool.dockerImageId).toMatch(/^sha256:/)
    const rootfs = path.join(workDir, manifest.rootfsDirs[0] as string)
    // readFile on etc/passwd proves real file content, not just a directory skeleton.
    expect(await readFile(path.join(rootfs, 'etc/passwd'), 'utf8')).toMatch(/^root:/m)
    await expect(readFile(path.join(rootfs, 'bin/busybox'))).resolves.toBeInstanceOf(Buffer)

    // force must be able to delete the previous tree — on Windows it contains
    // junctions Node can't remove (see removeAnalysisDir).
    const again = await unpackFirmware({ imagePath: E2E_IMAGE as string, outRoot, force: true })
    expect(again.manifest.rootfsDirs).toEqual(manifest.rootfsDirs)

    // Clean up here, while the analyzer image is known to be present;
    // the plain fs.rm in afterEach would hit the same junctions.
    await removeAnalysisDir(workDir)
    await expect(readFile(path.join(workDir, 'unpack.json'))).rejects.toThrow()
  })
})
