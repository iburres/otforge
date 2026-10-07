/**
 * docker-client.ts — Thin wrapper around the Docker Compose CLI.
 *
 * The OTForge runs each scenario as a set of Docker containers defined by
 * a generated docker-compose.yml. This module encapsulates every `docker compose`
 * command so the rest of the codebase never constructs raw shell strings.
 *
 * Design decisions:
 *   - All commands run through `execAsync` with a custom PATH that includes the
 *     Docker Desktop binary directories. Electron inherits a stripped launcher PATH,
 *     so Docker is not on PATH by default on Windows.
 *   - Compose files are written to `<userData>/scenarios/<projectName>/docker-compose.yml`
 *     so each scenario has its own isolated directory. This allows multiple distinct
 *     scenario compose files to coexist without collision.
 *   - `docker compose ps --format json` outputs one JSON object per stdout line
 *     (newline-delimited JSON), not a JSON array. Parsing is done line-by-line.
 *
 * Usage:
 *   const client = new DockerClient(app.getPath('userData'))
 *   await client.startScenario(projectName, composeYaml)
 *   const statuses = await client.getStatus(projectName)
 *   await client.stopScenario(projectName)
 */

import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import type { ContainerStatus } from '@otforge/schema'

const execAsync = promisify(exec)

/**
 * Platform-specific directories where the Docker CLI binary may be installed.
 *
 * Electron apps launched from the desktop icon inherit a minimal PATH that
 * typically excludes Docker Desktop's binary directory on Windows. These paths
 * are prepended to every `docker` invocation to guarantee the binary is found.
 */
const DOCKER_PATHS: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\Docker\\Docker\\resources\\bin',
    'C:\\ProgramData\\DockerDesktop\\version-bin'
  ],
  darwin: [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/Applications/Docker.app/Contents/Resources/bin'
  ],
  linux: ['/usr/bin', '/usr/local/bin']
}

/**
 * Constructs a process environment with Docker binary directories prepended to PATH.
 *
 * @returns A copy of process.env with Docker paths at the front so `docker compose`
 *   resolves correctly on all platforms regardless of how the app was launched.
 */
function buildEnv(): NodeJS.ProcessEnv {
  const extra = (DOCKER_PATHS[process.platform] ?? []).join(
    process.platform === 'win32' ? ';' : ':'
  )
  const sep = process.platform === 'win32' ? ';' : ':'
  return { ...process.env, PATH: `${extra}${sep}${process.env.PATH ?? ''}` }
}

/**
 * Runs a shell command with the augmented Docker PATH environment.
 *
 * maxBuffer is set to 50 MB (vs the Node.js default of 1 MB) because
 * `docker compose up` writes layer-download progress to stderr during the
 * first image pull of a scenario. Each image can produce hundreds of lines
 * of "Pulling layer … / Pull complete" output; across 10+ images the combined
 * stderr easily exceeds the default limit and throws "maxBuffer length exceeded".
 *
 * @param cmd - The shell command string to execute.
 * @returns stdout and stderr strings from the command.
 * @throws If the command exits with a non-zero status.
 */
async function run(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { env: buildEnv(), maxBuffer: 50 * 1024 * 1024 })
}

/**
 * Extracts the unique set of image names referenced in a docker-compose YAML string.
 *
 * Looks for `image:` keys at any indentation level.  The compose generator always
 * emits explicit `image:` entries for every service, so a simple regex is reliable
 * here without pulling in a full YAML parser.
 *
 * @param composeYaml - Raw docker-compose.yml content.
 * @returns Deduplicated array of image reference strings (e.g. "ghcr.io/…:latest").
 */
function extractImages(composeYaml: string): string[] {
  const images = new Set<string>()
  const re = /^\s+image:\s+['"]?([^\s'"]+)['"]?/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(composeYaml)) !== null) {
    if (m[1]) images.add(m[1])
  }
  return [...images]
}

/**
 * DockerClient wraps Docker Compose CLI operations for a single scenario.
 *
 * Each scenario gets its own subdirectory under `<userData>/scenarios/` containing
 * the generated docker-compose.yml. The Docker Compose project name scopes all
 * container, network, and volume names to that scenario, allowing multiple compose
 * environments to coexist on the same machine without name collisions.
 */
export class DockerClient {
  /** Absolute path to the directory where per-scenario subdirectories are created. */
  private readonly workDir: string

  /**
   * @param userDataPath - Electron's app.getPath('userData') directory.
   *   On Windows: %APPDATA%\otforge
   *   On macOS:   ~/Library/Application Support/otforge
   */
  constructor(userDataPath: string) {
    this.workDir = join(userDataPath, 'scenarios')
  }

  /**
   * Checks whether the Docker daemon is running by running `docker version`.
   *
   * @returns true if the daemon responds, false if Docker is not installed or not running.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await run('docker version --format "{{.Server.Version}}"')
      return true
    } catch {
      return false
    }
  }

  /**
   * Writes a docker-compose.yml for the scenario and starts all containers.
   *
   * Steps:
   *   1. Create `<workDir>/<projectName>/` if it does not exist.
   *   2. Write the YAML string as `docker-compose.yml` in that directory.
   *   3. Fire `onPullNeeded()` so the renderer shows an "Importing Containers" overlay
   *      before the compose up begins when new images need to be downloaded.
   *   4. Run `docker compose up --pull missing -d --remove-orphans` to launch all services.
   *      `--pull missing` pulls an image only when it is not already present in the
   *      local Docker cache.  If a locally built or previously pulled image exists it
   *      is used as-is, which lets instructors test custom builds without having them
   *      overwritten by GHCR on every start.  Students who have never run a scenario
   *      still get all images pulled automatically on first launch.
   *      `--remove-orphans` removes containers from a previous run of the same
   *      project that are no longer defined in the new compose file.
   *
   * @param projectName  - Sanitized scenario name used as the Compose project name.
   *   Must match the Docker Compose project name constraint: lowercase alphanumeric + hyphen.
   * @param composeYaml  - Complete docker-compose.yml content as a YAML string.
   * @param onPullNeeded - Optional callback fired before compose up begins. Use to show
   *   a progress overlay in the UI during the image pull / digest check.
   * @returns { ok: true } on success, { ok: false, error } on failure.
   */
  async startScenario(
    projectName: string,
    composeYaml: string,
    onPullNeeded?: (type: 'import' | 'update') => void,
    onProgress?: (line: string) => void
  ): Promise<{ ok: boolean; error?: string }> {
    const scenarioDir = join(this.workDir, projectName)
    const composeFile = join(scenarioDir, 'docker-compose.yml')

    try {
      // recursive: true makes mkdir a no-op if the directory already exists
      await mkdir(scenarioDir, { recursive: true })
      await writeFile(composeFile, composeYaml, 'utf-8')

      // Best-effort: clear leftover containers/networks from an unclean stop so
      // `up` does not fail with "network … has active endpoints".
      try {
        // codeql[js/shell-command-constructed-from-input] -- projectName is sanitized to [a-z0-9-] by toProjectName()
        await run(
          `docker compose -p ${projectName} -f "${composeFile}" down --volumes --remove-orphans`
        )
      } catch {
        /* best-effort */
      }

      // Classify images as missing (first install) or present (possible update) so
      // the overlay can show "Importing Containers" vs "Updating Containers".
      // If any image is missing, 'import' takes priority over 'update'.
      const images = extractImages(composeYaml)
      const anyMissing = await this._hasNewImages(images)
      const pullType: 'import' | 'update' = anyMissing ? 'import' : 'update'

      // Start containers, streaming output so we can detect whether Docker is
      // actually pulling any images. onPullNeeded fires only when a "Pulling"
      // line appears — so the overlay is shown only when a download is in progress,
      // not on every start when all images are already cached locally.
      await this._composeUp(projectName, composeFile, () => onPullNeeded?.(pullType), onProgress)

      // Prune <none>:<none> dangling images left whenever Docker replaces an old
      // image digest with a newer pull. Best-effort — prune failure must not abort
      // a successful simulation start.
      try {
        await run('docker image prune -f')
      } catch {
        /* best-effort */
      }
      return { ok: true }
    } catch (err) {
      // Tear down any partial state left by the failed `up` — containers, volumes,
      // and especially networks. Without this cleanup the subnet addresses remain
      // allocated and the next attempt fails with "Address already in use".
      try {
        // codeql[js/shell-command-constructed-from-input] -- projectName is sanitized to [a-z0-9-] by toProjectName()
        await run(`docker compose -p ${projectName} -f "${composeFile}" down --volumes`)
      } catch {
        /* best-effort */
      }

      // _composeUp attaches collected output to the error as _composeOutput so we
      // can write it to a log without relying on execAsync's stderr field.
      const composeErr = err as Error & { _composeOutput?: string }
      const rawOutput = composeErr._composeOutput ?? composeErr.message

      const logPath = join(scenarioDir, 'compose-error.log')
      try {
        await writeFile(logPath, rawOutput, 'utf-8')
      } catch {
        /* log write failure is non-fatal */
      }

      const errorLines = rawOutput
        .split('\n')
        .map(l => l.trim())
        .filter(l => /error|failed|cannot|invalid|denied|unauthorized|no such/i.test(l))
        .filter(Boolean)
        .filter((l, i, arr) => arr.indexOf(l) === i)
        .slice(0, 8)

      const shortError =
        errorLines.length > 0
          ? errorLines.join('\n')
          : `docker compose exited with an error. Full log: ${logPath}`

      return { ok: false, error: shortError }
    }
  }

  /**
   * Runs `docker compose up --pull missing` via spawn so output can be streamed
   * line-by-line. This avoids the maxBuffer limit of execAsync and lets the caller
   * detect when Docker actually starts pulling images (rather than just checking
   * digests), so the "Updating Images" overlay is shown only when a download is
   * in progress.
   *
   * onPullNeeded fires at most once, when the first line containing "Pulling"
   * appears. If all images are already present locally Docker only prints
   * container-start lines and onPullNeeded never fires — no overlay is shown.
   */
  private _composeUp(
    projectName: string,
    composeFile: string,
    onPullNeeded?: () => void,
    onProgress?: (line: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let pullNotified = false
      const allLines: string[] = []

      const child = spawn(
        'docker',
        [
          'compose',
          '-p',
          projectName,
          '-f',
          composeFile,
          'up',
          '--pull',
          'missing',
          '-d',
          '--remove-orphans'
        ],
        { env: buildEnv() }
      )

      const processChunk = (buf: Buffer): void => {
        // Docker uses \r to overwrite progress lines in-place on a TTY.
        // Replace \r with \n so we split on both.
        buf
          .toString()
          .replace(/\r/g, '\n')
          .split('\n')
          .forEach(raw => {
            // Strip ANSI escape sequences before forwarding to the renderer.
            // eslint-disable-next-line no-control-regex
            const line = raw.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').trim()
            if (!line) return

            allLines.push(line)
            onProgress?.(line)

            // Fire onPullNeeded only once — when Docker first reports it is
            // actually downloading an image layer, not just checking the digest.
            if (!pullNotified && /pulling/i.test(line)) {
              pullNotified = true
              onPullNeeded?.()
            }
          })
      }

      child.stdout?.on('data', processChunk)
      child.stderr?.on('data', processChunk)

      child.on('close', code => {
        if (code === 0) {
          resolve()
        } else {
          const e = new Error(`docker compose up exited with code ${code}`) as Error & {
            _composeOutput: string
          }
          e._composeOutput = allLines.join('\n')
          reject(e)
        }
      })

      child.on('error', reject)
    })
  }

  /**
   * Returns true if at least one of the supplied image references is not present
   * in the local Docker image cache.
   *
   * Uses `docker image inspect --format {{.Id}}` which exits non-zero when the
   * image is not found locally.  A single missing image is enough to classify
   * the upcoming pull as an 'import' rather than an 'update'.
   *
   * @param images - Image reference strings from the compose file.
   */
  private async _hasNewImages(images: string[]): Promise<boolean> {
    for (const image of images) {
      try {
        // codeql[js/shell-command-constructed-from-input] -- image names come from the compose YAML generated by compose-generator.ts, not user input
        await run(`docker image inspect ${JSON.stringify(image)} --format "{{.Id}}"`)
      } catch {
        return true
      }
    }
    return false
  }

  /**
   * Stops and removes all containers, networks, and volumes for a scenario.
   *
   * Runs `docker compose down --volumes` which:
   *   - Stops all running services
   *   - Removes containers
   *   - Removes the Docker networks created by the compose file
   *   - Removes named and anonymous volumes (clears historian data, log files, etc.)
   *
   * @param projectName - The Compose project name used when the scenario was started.
   * @returns { ok: true } on success, { ok: false, error } on failure.
   */
  async stopScenario(projectName: string): Promise<{ ok: boolean; error?: string }> {
    const composeFile = join(this.workDir, projectName, 'docker-compose.yml')
    try {
      // codeql[js/shell-command-constructed-from-input] -- projectName is sanitized to [a-z0-9-] by toProjectName()
      await run(`docker compose -p ${projectName} -f "${composeFile}" down --volumes`)
      // Remove dangling images (<none>:<none>) left when Docker replaces a local image.
      // When Docker pulls a newer digest for a tagged image it untags the old one,
      // producing a dangling layer that consumes real disk space but is unreachable
      // by name. Best-effort — if prune fails (e.g. another compose is running) the
      // simulation stop itself still succeeds.
      try {
        await run('docker image prune -f')
      } catch {
        /* best-effort */
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * Deletes the scenario directory and its compose file from disk.
   *
   * Called after a successful stop when the project data is no longer needed.
   * Force-deletes so it succeeds even if the directory is partially empty.
   *
   * @param projectName - The Compose project name (directory name under workDir).
   */
  async cleanScenario(projectName: string): Promise<void> {
    const scenarioDir = join(this.workDir, projectName)
    await rm(scenarioDir, { recursive: true, force: true })
  }

  /**
   * Polls the current state and health of all containers in a running scenario.
   *
   * Parses the newline-delimited JSON output of `docker compose ps --format json`.
   * Each line is a separate JSON object with Name, State, and Health fields.
   *
   * Docker health states: healthy | unhealthy | starting | "" (no health check configured)
   * Docker container states: running | exited | dead | created | starting
   *
   * @param projectName - The Compose project name to query.
   * @returns Array of ContainerStatus objects, empty if the project is not running.
   */
  async getStatus(projectName: string): Promise<ContainerStatus[]> {
    try {
      // codeql[js/shell-command-constructed-from-input] -- projectName is sanitized to [a-z0-9-] by toProjectName()
      const { stdout } = await run(`docker compose -p ${projectName} ps --format json`)
      const statuses = parseComposePs(stdout, projectName)
      if (statuses.length === 0) return statuses

      // A crash-looping container flips between "running" and "restarting", so a 3 s
      // poll can catch either; RestartCount is the reliable signal. compose ps doesn't
      // report it, so read it for every container with one `docker inspect` call.
      // Failure here must not lose the statuses, so it's caught separately.
      try {
        const names = statuses.map(s => s.containerId).filter((n): n is string => !!n)
        // codeql[js/shell-command-constructed-from-input] -- container names come from docker compose ps for a sanitized project
        const inspect = await run(
          `docker inspect --format "{{.Name}}|{{.RestartCount}}" ${names.join(' ')}`
        )
        const counts = parseRestartCounts(inspect.stdout)
        for (const s of statuses) {
          const n = s.containerId ? counts.get(s.containerId) : undefined
          if (n !== undefined) s.restartCount = n
        }
      } catch {
        // A container can vanish between ps and inspect (e.g. during stop); skip counts.
      }
      return statuses
    } catch {
      // Compose project not found or docker not running — return empty rather than throwing
      return []
    }
  }

  /**
   * Pulls the latest images for all services defined in a scenario's compose file.
   *
   * Used before starting a simulation to ensure GHCR images are up to date.
   * Not called automatically on start — the UI can offer a "Pull latest" action.
   *
   * @param projectName - The Compose project name whose compose file to read.
   * @returns { ok: true } on success, { ok: false, error } on failure.
   */
  async pullImages(projectName: string): Promise<{ ok: boolean; error?: string }> {
    const composeFile = join(this.workDir, projectName, 'docker-compose.yml')
    try {
      // codeql[js/shell-command-constructed-from-input] -- projectName is sanitized to [a-z0-9-] by toProjectName()
      await run(`docker compose -p ${projectName} -f "${composeFile}" pull`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * Force-pulls the newest version of every image in a scenario, streaming
   * progress line-by-line. Backs the toolbar "Update Images" action.
   *
   * Unlike `docker compose up --pull missing` (used on start), this runs
   * `docker compose pull`, which ALWAYS re-fetches each `:latest` tag even when
   * an older copy is already cached. This is the only path by which a student
   * who pulled an image weeks ago receives an updated GHCR image — the default
   * `pull_policy: if_not_present` never re-pulls a tag that already exists
   * locally.
   *
   * The compose file is (re)written from the supplied YAML first, so this works
   * even for a scenario that has never been started (no compose file on disk yet).
   * Running containers are not affected — `pull` only refreshes the local image
   * cache; the new image takes effect on the next simulation start.
   *
   * @param projectName - Sanitized Compose project name (lowercase alphanumeric + hyphen).
   * @param composeYaml - Complete docker-compose.yml content as a YAML string.
   * @param onProgress  - Optional callback fired with each cleaned output line.
   * @returns { ok: true } on success, { ok: false, error } on failure.
   */
  async updateImages(
    projectName: string,
    composeYaml: string,
    onProgress?: (line: string) => void
  ): Promise<{ ok: boolean; error?: string }> {
    const scenarioDir = join(this.workDir, projectName)
    const composeFile = join(scenarioDir, 'docker-compose.yml')

    try {
      // recursive: true makes mkdir a no-op if the directory already exists
      await mkdir(scenarioDir, { recursive: true })
      await writeFile(composeFile, composeYaml, 'utf-8')
      await this._composePull(projectName, composeFile, onProgress)
      return { ok: true }
    } catch (err) {
      const pullErr = err as Error & { _composeOutput?: string }
      const rawOutput = pullErr._composeOutput ?? pullErr.message
      const errorLines = rawOutput
        .split('\n')
        .map(l => l.trim())
        .filter(l => /error|failed|cannot|denied|unauthorized|no such|not found/i.test(l))
        .filter((l, i, arr) => arr.indexOf(l) === i)
        .slice(0, 8)
      const shortError =
        errorLines.length > 0 ? errorLines.join('\n') : `docker compose pull failed: ${rawOutput}`
      return { ok: false, error: shortError }
    }
  }

  /**
   * Runs `docker compose pull` via spawn so output can be streamed line-by-line,
   * mirroring the cleaning logic in `_composeUp` (CR→LF split, ANSI strip).
   */
  private _composePull(
    projectName: string,
    composeFile: string,
    onProgress?: (line: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const allLines: string[] = []
      const child = spawn('docker', ['compose', '-p', projectName, '-f', composeFile, 'pull'], {
        env: buildEnv()
      })

      const processChunk = (buf: Buffer): void => {
        buf
          .toString()
          .replace(/\r/g, '\n')
          .split('\n')
          .forEach(raw => {
            // eslint-disable-next-line no-control-regex
            const line = raw.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').trim()
            if (!line) return
            allLines.push(line)
            onProgress?.(line)
          })
      }

      child.stdout?.on('data', processChunk)
      child.stderr?.on('data', processChunk)

      child.on('close', code => {
        if (code === 0) {
          resolve()
        } else {
          const e = new Error(`docker compose pull exited with code ${code}`) as Error & {
            _composeOutput: string
          }
          e._composeOutput = allLines.join('\n')
          reject(e)
        }
      })

      child.on('error', reject)
    })
  }

  /**
   * Returns the absolute path to a scenario's docker-compose.yml file.
   *
   * @param projectName - The Compose project name.
   * @returns Absolute file path (may not exist if the scenario hasn't been started).
   */
  composeFilePath(projectName: string): string {
    return join(this.workDir, projectName, 'docker-compose.yml')
  }
}

/**
 * Maps Docker container state strings to the ContainerStatus.status union type.
 *
 * Docker reports lowercase state names. "exited" and "dead" both indicate an
 * error condition (the container stopped unexpectedly). "created" and "starting"
 * indicate the container has been scheduled but hasn't entered the running state.
 *
 * @param state - Raw state string from `docker compose ps`.
 * @returns Mapped ContainerStatus status value.
 */
function mapDockerState(state: string): ContainerStatus['status'] {
  switch (state.toLowerCase()) {
    case 'running':
      return 'running'
    case 'exited':
    case 'dead':
      return 'error'
    case 'created':
    case 'starting':
      return 'starting'
    // Between restart attempts after a crash. This used to fall through to 'stopped',
    // which hid a crash-looping container (e.g. Suricata killed by a bad custom rule).
    case 'restarting':
      return 'restarting'
    default:
      return 'stopped'
  }
}

/**
 * Parses `docker compose ps --format json` output into ContainerStatus entries.
 *
 * Compose prints one JSON object per line (not a JSON array). Its ExitCode field reads
 * 0 even while a container is crash-looping (verified on Docker 28), so the real exit
 * code comes from the Status text instead: "Restarting (1) 5 seconds ago".
 *
 * @param stdout      - Raw `docker compose ps --format json` output.
 * @param projectName - Compose project name; its "<project>-" prefix is stripped from
 *                      container names to get the node id (e.g. "lab-suricata" → "suricata").
 */
export function parseComposePs(stdout: string, projectName: string): ContainerStatus[] {
  return stdout
    .trim()
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const obj = JSON.parse(line) as {
        Name: string
        State: string
        Health?: string
        Status?: string
      }
      const entry: ContainerStatus = {
        nodeId: obj.Name.replace(`${projectName}-`, ''),
        containerId: obj.Name,
        status: mapDockerState(obj.State)
      }
      // healthCheck is an optional field — only set it when Docker reports a health state
      const health = mapDockerHealth(obj.Health ?? '')
      if (health !== undefined) entry.healthCheck = health
      const exit = /^Restarting \((\d+)\)/.exec(obj.Status ?? '')
      if (exit) entry.lastExitCode = parseInt(exit[1]!, 10)
      return entry
    })
}

/**
 * Parses `docker inspect --format "{{.Name}}|{{.RestartCount}}"` output into a map of
 * container name → restart count. Inspect prefixes names with "/", which is stripped
 * so keys match the names `docker compose ps` reports.
 *
 * @param stdout - Raw inspect output, one "name|count" line per container.
 */
export function parseRestartCounts(stdout: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const m = /^\/?([^|]+)\|(\d+)\s*$/.exec(line.trim())
    if (m) counts.set(m[1]!, parseInt(m[2]!, 10))
  }
  return counts
}

/**
 * Maps Docker health check strings to the ContainerStatus.healthCheck union type.
 *
 * Returns undefined (not null) when no health check is configured — the schema
 * uses `healthCheck?: string` so undefined means "field absent", which is the
 * correct representation for containers without a HEALTHCHECK directive.
 *
 * @param health - Raw health string from `docker compose ps` ("healthy", "unhealthy",
 *   "starting", or "" when no health check is defined).
 * @returns Mapped health string or undefined.
 */
function mapDockerHealth(health: string): ContainerStatus['healthCheck'] {
  switch (health.toLowerCase()) {
    case 'healthy':
      return 'healthy'
    case 'unhealthy':
      return 'unhealthy'
    case 'starting':
      return 'starting'
    default:
      // Empty string means the container has no HEALTHCHECK instruction
      return undefined
  }
}
