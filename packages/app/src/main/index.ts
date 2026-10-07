/**
 * index.ts — Electron main process entry point.
 *
 * This is the "backend" of the Electron application. It runs in Node.js with full
 * system access and is responsible for:
 *
 *   1. Creating and managing the BrowserWindow (renderer host)
 *   2. Registering IPC handlers that the renderer calls via window.electronAPI
 *   3. Checking whether Docker Desktop is installed and running
 *   4. Driving the simulation lifecycle (start / stop / status)
 *   5. Persisting scenario state to LevelDB across app restarts
 *
 * Security model:
 *   - contextIsolation: true — renderer cannot access Node.js APIs directly
 *   - nodeIntegration: false — no require() in renderer
 *   - All communication goes through contextBridge (preload/index.ts)
 *
 * IPC channel naming convention:  "<domain>:<action>"
 *   app:info, docker:check, scenario:import, simulation:start, etc.
 */

import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type {
  AppInfo,
  DockerStatus,
  ScenarioImportResult,
  ScenarioExportResult,
  ScenarioExportOptions,
  ScenarioDeleteFileResult,
  SimulationStartResult,
  SimulationStopResult,
  AppUpdateResult,
  SessionSummary,
  SessionSaveResult,
  SessionLoadResult,
  ContainerStatus,
  OTForgeScenario,
  DeviceConfig,
  PLCDeployResult,
  PLCRuntimeStatus,
  PackInstallResult,
  PackListResult,
  PackUninstallResult,
  OTForgePackManifest,
  PackDeviceType,
  ResolvedPackDeviceType,
  PackScenarioMeta,
  InstalledPack,
  PlcImportResult
} from '@otforge/schema'
import { readFile, writeFile, access, mkdir, readdir, rm } from 'fs/promises'
import { exec, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { promisify } from 'util'
import { join as pathJoin, relative as pathRelative } from 'path'
import os from 'os'
import http from 'http'
import net from 'net'
import {
  generateCompose,
  DockerClient,
  estimateResources,
  checkSystemMemory,
  getAvailableMemMb,
  validateScenario,
  toProjectName,
  writeGrafanaProvisioning,
  findFreeSubnets,
  ZONE_DEFAULTS,
  getOtZoneTopology
} from '@otforge/orchestrator'
import type { OtZoneDevice, OtZoneTopology } from '@otforge/orchestrator'
import type { NetworkZone, ACLRule, SuricataRuleCheckResult } from '@otforge/schema'
import { initDb, saveActiveScenario, loadActiveScenario, clearActiveScenario } from './db'
import { saveSession, loadSession, listSessions, sessionDir } from './sessions'
import { parsePlcFile } from './plc-import'

const execAsync = promisify(exec)

// ── Network settings ───────────────────────────────────────────────────────────

/**
 * Persisted network configuration for Docker subnet assignment.
 *
 * Stored as JSON at <userData>/settings.json. Controls whether the simulator
 * auto-detects non-conflicting subnets at each simulation start or uses a
 * user-pinned set of subnets instead.
 *
 * autoDetect:     When true (default), findFreeSubnets() scans os.networkInterfaces()
 *                 at every simulation start and picks /24 subnets in the 10.200–10.210.x
 *                 range that don't conflict with any existing host interface.
 *
 * pinnedSubnets:  Used only when autoDetect is false. The renderer's Settings modal
 *                 populates this from user-edited subnet inputs. Should include all six
 *                 zones (ot, control, plant-dmz, enterprise, internet-dmz, attacker).
 */
interface NetworkSettings {
  autoDetect: boolean
  pinnedSubnets?: Record<string, { subnet: string; gateway: string }>
}

/**
 * Returns the absolute path to the settings JSON file.
 * Computed at call time (not module load) so app.getPath() is always ready.
 */
function settingsPath(): string {
  return pathJoin(app.getPath('userData'), 'settings.json')
}

/**
 * Returns the absolute path to the scenarios library directory.
 *
 * In development (electron-vite dev server running from the project root):
 *   <project-root>/scenarios/
 *   e.g. C:\Users\iburr\OTForge\scenarios
 *
 * In production (packaged app):
 *   <user Documents>/OTForge/Scenarios/
 *   Instructors can drop .otflab files here and they appear in the open dialog.
 *
 * The directory is created on first call if it does not exist.
 */
function getScenariosLibraryDir(): string {
  if (is.dev) {
    // app.getAppPath() returns <project>/packages/app in electron-vite dev mode.
    // The bundled scenarios/ folder lives two levels up at the project root.
    return pathJoin(app.getAppPath(), '..', '..', 'scenarios')
  }
  return pathJoin(app.getPath('documents'), 'OTForge', 'Scenarios')
}

/**
 * Returns the directory the Export save dialog should default into.
 *
 * In production this is identical to getScenariosLibraryDir() (Documents/OTForge/
 * Scenarios) — not a git checkout, so there's nothing to protect.
 *
 * In dev mode, getScenariosLibraryDir() points at the project's tracked
 * scenarios/ folder. Defaulting Export there means any custom-named save (or a
 * student just trying the button) drops a new file into a git-tracked
 * directory. That file is untracked, but the "Update OTForge" dirty-tree
 * guard used to treat untracked files as blocking too, so a single stray
 * export permanently broke updates until someone who knew git cleaned it up
 * (the guard itself no longer counts untracked files, but keeping exports out
 * of the tracked tree in the first place avoids the confusion of `git status`
 * showing files the student never intentionally added to the project).
 * custom/ is created on demand and is gitignored.
 */
async function getScenarioExportDir(): Promise<string> {
  if (!is.dev) {
    return getScenariosLibraryDir()
  }
  const dir = pathJoin(getScenariosLibraryDir(), 'custom')
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Returns the absolute path to the git checkout root (the npm workspaces
 * project root, two levels up from packages/app in electron-vite dev mode).
 *
 * Only meaningful when `is.dev` is true — a packaged build has no .git
 * directory or workspace package.json, so the "Update OTForge" self-updater
 * (app:update) refuses to run outside dev mode. Callers must check `is.dev`
 * before calling this.
 */
function getProjectRoot(): string {
  return pathJoin(app.getAppPath(), '..', '..')
}

/**
 * Sentinel dropped at the project root by the 'app:update' handler to request a
 * `npm update` on the next launch, and consumed by scripts/apply-pending-update.mjs
 * from `predev`. The name must stay in sync with SENTINEL in that script.
 *
 * The indirection exists because npm cannot safely replace node_modules/electron
 * while Electron is running — see the long comment in the 'app:update' handler.
 *
 * Gitignored, so it can never trip that same handler's dirty-working-tree guard.
 */
const PENDING_DEP_UPDATE_FILE = '.otforge-pending-dep-update'

/**
 * Runs a command via spawn(), streaming stdout+stderr to onProgress line-by-line
 * (CR→LF split, ANSI escape codes stripped) — mirrors DockerClient's internal
 * `_composePull` streaming so `git pull`/`npm install` output renders the same
 * way as `docker compose pull` output in the update overlay. `shell: true` lets
 * Windows resolve `npm` (a .cmd shim) the same way `git` resolves as a normal
 * binary, without hardcoding a platform-specific executable name.
 *
 * `command` and `args` are joined into a single string rather than passed as
 * `spawn(command, args, { shell: true })` — Node deprecates (DEP0190) passing a
 * separate args array alongside shell: true, since the shell only ever sees the
 * concatenated string anyway (no real escaping happens). Safe here because
 * every caller passes fixed literal tokens ('pull', 'install', ...), never
 * user-supplied or path-derived values that could contain shell metacharacters.
 *
 * Rejects with an Error including the last few output lines if the process
 * exits non-zero, so the renderer can show a useful message instead of a bare
 * exit code.
 */
function runStreamedCommand(
  command: string,
  args: string[],
  cwd: string,
  onProgress?: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const allLines: string[] = []
    const child = spawn([command, ...args].join(' '), { cwd, shell: true })

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
        reject(
          new Error(
            `${command} ${args.join(' ')} exited with code ${code}: ${allLines.slice(-8).join(' | ')}`
          )
        )
      }
    })

    child.on('error', reject)
  })
}

/**
 * Absolute path of the .otflab file most recently opened or saved by the user.
 * Set by scenario:import and scenario:export; cleared by scenario:deleteFile.
 * Used by scenario:deleteFile to know which file to remove from disk.
 */
let activeScenarioFilePath: string | null = null

/**
 * Reads the stored NetworkSettings from disk.
 *
 * Returns a safe default ({ autoDetect: true }) if the file does not exist yet
 * (first launch, or user deleted the file) or cannot be parsed. This guarantees
 * the app always has a valid settings object to work with.
 */
async function readSettings(): Promise<NetworkSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf-8'))
    // Merge with default so any added fields in future versions get defaults
    return { autoDetect: true, ...raw }
  } catch {
    // File absent on first launch, or corrupted — fall back to auto-detect
    return { autoDetect: true }
  }
}

/**
 * Persists a NetworkSettings object to <userData>/settings.json.
 * The file is created if it does not exist (mkdir not needed — userData always exists).
 *
 * @param settings - The settings to write.
 */
async function writeSettings(settings: NetworkSettings): Promise<void> {
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}

/**
 * Scans the host's network interfaces via os.networkInterfaces() and returns
 * a deduplicated list of CIDR strings normalized to network base addresses.
 *
 * Normalization: os.networkInterfaces() returns addr.cidr as the host address
 * with prefix length (e.g., "192.168.1.100/24"). We convert this to the network
 * base ("192.168.1.0/24") so findFreeSubnets() can correctly detect whether a
 * candidate subnet overlaps with an existing interface's range — even when the
 * existing interface uses a broad mask like /8 or /16.
 *
 * Internal loopback addresses (127.0.0.1, ::1) are excluded.
 * Single-host /32 addresses are excluded (they don't define a subnet to avoid).
 *
 * @returns Array of unique network-base CIDR strings (e.g., ["192.168.1.0/24", "10.8.0.0/16"]).
 */
function getInUseCidrs(): string[] {
  const cidrs: string[] = []
  for (const iface of Object.values(os.networkInterfaces())) {
    if (!iface) continue
    for (const addr of iface) {
      // Skip IPv6 (Docker networks are IPv4), loopback, and addresses without CIDR notation
      if (addr.family !== 'IPv4' || addr.internal || !addr.cidr) continue
      const [ip, bits] = addr.cidr.split('/')
      const prefix = parseInt(bits)
      // /32 means a single host address — not a routable subnet to avoid
      if (prefix === 32) continue
      // Compute the network base by zeroing host bits using bitwise AND with the mask
      const mask = prefix === 0 ? 0 : ~((1 << (32 - prefix)) - 1) >>> 0
      const ipInt =
        ip.split('.').reduce((acc: number, o: string) => (acc << 8) + parseInt(o), 0) >>> 0
      const netInt = (ipInt & mask) >>> 0
      const net = [
        (netInt >>> 24) & 0xff,
        (netInt >>> 16) & 0xff,
        (netInt >>> 8) & 0xff,
        netInt & 0xff
      ].join('.')
      cidrs.push(`${net}/${bits}`)
    }
  }
  // Deduplicate — multiple interfaces can share the same network segment
  return [...new Set(cidrs)]
}

/**
 * Resolves the Docker zone-to-subnet map to use for the next simulation.
 *
 * Logic:
 *   1. Read settings.json.
 *   2. If autoDetect is false AND pinnedSubnets covers all four zones, use pinned subnets.
 *   3. Otherwise, run findFreeSubnets() against the current host interface list.
 *
 * The returned map is passed to generateCompose() and writeGrafanaProvisioning()
 * so every container IP and every Grafana datasource URL uses the same subnets.
 *
 * @returns Promise resolving to a complete zone → { subnet, gateway } map.
 */
async function resolveZones(): Promise<Record<NetworkZone, { subnet: string; gateway: string }>> {
  const settings = await readSettings()

  if (!settings.autoDetect && settings.pinnedSubnets) {
    // Use pinned values, falling back to ZONE_DEFAULTS for any missing zone.
    // This guards against partially-filled pinnedSubnets from older settings files
    // (e.g., saved before the 6-zone Purdue refactor added plant-dmz/enterprise/internet-dmz).
    const pins = settings.pinnedSubnets
    return {
      ot: { ...(pins.ot ?? ZONE_DEFAULTS.ot) },
      control: { ...(pins.control ?? ZONE_DEFAULTS.control) },
      'plant-dmz': { ...(pins['plant-dmz'] ?? ZONE_DEFAULTS['plant-dmz']) },
      enterprise: { ...(pins.enterprise ?? ZONE_DEFAULTS.enterprise) },
      'internet-dmz': { ...(pins['internet-dmz'] ?? ZONE_DEFAULTS['internet-dmz']) },
      attacker: { ...(pins.attacker ?? ZONE_DEFAULTS.attacker) }
    }
  }

  // Auto-detect: walk os.networkInterfaces() and pick non-conflicting /24 subnets
  return findFreeSubnets(getInUseCidrs())
}

/**
 * Platform-specific directories where Docker CLI binaries may live.
 *
 * Electron inherits a stripped PATH from the OS launcher (not a terminal),
 * so on Windows the Docker Desktop install directory is typically absent.
 * We prepend these paths before every `docker` invocation.
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
 * Builds a process environment with Docker's CLI directories prepended to PATH.
 *
 * @returns A copy of process.env with Docker binary paths prepended so that
 *   `docker` commands succeed regardless of how the app was launched.
 */
function buildDockerEnv(): NodeJS.ProcessEnv {
  const extra = (DOCKER_PATHS[process.platform] ?? []).join(
    process.platform === 'win32' ? ';' : ':'
  )
  const sep = process.platform === 'win32' ? ';' : ':'
  return { ...process.env, PATH: `${extra}${sep}${process.env.PATH ?? ''}` }
}

/**
 * Direct download URLs shown when the user needs to install Docker Desktop.
 * Linux points to the docs page rather than a binary — Docker Desktop on Linux
 * requires distribution-specific package manager steps.
 */
const DOCKER_DOWNLOAD_URLS: Record<string, string> = {
  win32: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
  darwin: 'https://desktop.docker.com/mac/main/arm64/Docker.dmg',
  linux: 'https://docs.docker.com/desktop/install/linux/'
}

/**
 * Determines whether this is the first time the app has launched on this machine.
 *
 * Uses a sentinel file `<userData>/.launched` as a flag. On the first run the
 * file does not exist — we create it and return true. Every subsequent run the
 * file exists and we return false immediately.
 *
 * @returns true on the very first launch, false on all subsequent launches.
 */
async function isFirstLaunch(): Promise<boolean> {
  const flagPath = pathJoin(app.getPath('userData'), '.launched')
  try {
    await access(flagPath)
    return false
  } catch {
    // File absent → first launch. Create it so future runs return false.
    await writeFile(flagPath, '1', 'utf-8')
    return true
  }
}

/**
 * Pings the Docker daemon to verify it is running.
 *
 * Runs `docker version` which requires the daemon to respond. If the command
 * throws (daemon not running, docker not installed), returns available: false.
 *
 * @returns Object with `available` boolean.
 */
async function checkDocker(): Promise<{ available: boolean }> {
  try {
    await execAsync('docker version --format "{{.Server.Version}}"', { env: buildDockerEnv() })
    return { available: true }
  } catch {
    return { available: false }
  }
}

/**
 * Displays a native dialog prompting the user to install Docker Desktop.
 *
 * Called only on the first launch when Docker is not detected. Offers a button
 * that opens the appropriate platform download URL in the system browser.
 */
function showDockerInstallPrompt(): void {
  const url = DOCKER_DOWNLOAD_URLS[process.platform] ?? DOCKER_DOWNLOAD_URLS['linux']
  dialog
    .showMessageBox(mainWindow!, {
      type: 'info',
      title: 'Docker Desktop Required',
      message: 'OTForge requires Docker Desktop',
      detail:
        'Docker Desktop creates the isolated virtual networks that power every simulation.\n\n' +
        'Click "Download Docker Desktop" to get the installer. Once installed, start Docker Desktop ' +
        'and look for the whale icon in your system tray before launching a simulation.\n\n' +
        'Docker Desktop is free for personal and educational use.',
      buttons: ['Download Docker Desktop', 'I Already Have It'],
      defaultId: 0,
      cancelId: 1
    })
    .then(({ response }) => {
      if (response === 0) shell.openExternal(url)
    })
}

/** The single BrowserWindow instance — null before the window is created. */
let mainWindow: BrowserWindow | null = null

/** Manages Docker Compose lifecycle for scenario containers. */
let dockerClient: DockerClient

/**
 * The Docker Compose project name for the currently running simulation.
 * Null when no simulation is active. Used by stop/status IPC handlers.
 */
let activeProjectName: string | null = null

/**
 * Zone → CIDR subnet map captured at simulation start.
 * Needed by firewall:reload to generate nft address-match rules without
 * re-running zone resolution. Cleared when the simulation stops.
 */
let activeZones: Record<NetworkZone, string> | null = null

/**
 * Maps PLC device nodeIds to their published host ports for the OpenPLC web
 * interface. Populated when a simulation starts (same ordering as the compose
 * generator's PLC_WEB_PORT_BASE + index logic) and cleared when it stops.
 *
 * Used by the plc:deploy IPC handler to route HTTP API calls to the correct
 * container. Ports start at 18080 (first PLC in Object.entries iteration order,
 * matching compose-generator.ts).
 */
const activePlcPorts = new Map<string, number>()

/**
 * Maps PLC device nodeIds to their published Modbus TCP host ports.
 * Base port 18550 matches PLC_MODBUS_PORT_BASE in compose-generator.ts.
 * Populated at simulation start, cleared on stop.
 *
 * Used by modbus:readCoils to connect directly to the PLC's Modbus server from
 * the Electron main process and read coil states for the pipe-flow animation.
 */
const activePlcModbusPorts = new Map<string, number>()

/**
 * Maps attack-machine device nodeIds to their published host ports.
 * Populated on simulation start with the same index ordering as the compose
 * generator's ATTACK_NOVNC_PORT_BASE=6900 logic (host port → container port 3000).
 *
 * Used by attack:launchWindow and terminal:getVncUrl to build the KasmVNC URL.
 */
const activeAttackPorts = new Map<string, number>()

/**
 * Tracks open noVNC BrowserWindows keyed by attack-machine device nodeId.
 * Populated by attack:launchWindow, cleaned up on window 'closed' event.
 * Used by attack:pasteClipboard to inject host clipboard text into the
 * running noVNC page via executeJavaScript.
 */
const attackWindows = new Map<string, BrowserWindow>()

/**
 * Maps engineering-workstation device nodeIds to their published host ports.
 * Populated on simulation start with the same index ordering as the compose
 * generator's WORKSTATION_NOVNC_PORT_BASE=6800 logic (host port → container port 6080).
 *
 * Used by workstation:launchWindow and workstation:getVncUrl to build the noVNC URL.
 */
const activeWorkstationPorts = new Map<string, number>()

/**
 * Project name of a session the user just chose to Load, whose saved
 * Lab_NN_Student_Saved_Work folder should be copied back into the workstation on
 * the next simulation start for that project. Set by session:load, consumed and
 * cleared once by configureWorkstationSaveFolder. Null means "fresh run — do not
 * restore any prior work".
 */
let pendingSessionRestore: string | null = null

/**
 * Tracks open noVNC BrowserWindows keyed by engineering-workstation device nodeId.
 * Populated by workstation:launchWindow, cleaned up on window 'closed' event.
 */
const workstationWindows = new Map<string, BrowserWindow>()

/**
 * The currently active terminal process (docker exec session).
 * Only one terminal session is supported at a time — opening a second one
 * kills the previous. Null when no terminal is open.
 */
let activeTerminalProcess: ChildProcess | null = null

/**
 * The standalone xterm.js terminal BrowserWindow opened by attack:openTerminalWindow.
 * Null when the window is closed. The terminal:open handler routes terminal:data
 * events back to this window (or the main window's modal) via e.sender routing
 * so only one of the two callers ever receives PTY output.
 */
let terminalWindow: BrowserWindow | null = null

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const userData = app.getPath('userData')

  // Initialize LevelDB persistence store (singleton — safe to call multiple times)
  initDb(userData)

  // Initialize the Docker Compose client, pointing its work directory at userData/scenarios/
  dockerClient = new DockerClient(userData)

  createWindow()
  registerIPCHandlers()

  // Run first-launch check and Docker check concurrently to minimize startup latency
  const [first, dockerStatus] = await Promise.all([isFirstLaunch(), checkDocker()])
  if (first && !dockerStatus.available) {
    // Prompt new users who don't have Docker — existing users have already seen it
    showDockerInstallPrompt()
  }

  // macOS: re-create the window when the dock icon is clicked and no windows exist
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// On all platforms except macOS, quit the app when the last window is closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Window ─────────────────────────────────────────────────────────────────────

/**
 * Creates the main application window.
 *
 * Key settings:
 *   - `show: false` — window stays hidden until `ready-to-show` fires, preventing
 *     a white-flash on startup while the renderer loads
 *   - `contextIsolation: true` + `nodeIntegration: false` — renderer is sandboxed;
 *     all Node access goes through the preload contextBridge
 *   - `webviewTag: true` — required by Phase 6/7 for embedded Grafana and FUXA panels
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    autoHideMenuBar: true,
    title: 'OTForge',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  // Show maximized/fullscreen after the renderer has painted — avoids white-flash
  // and ensures the tutorial panel and canvas have full screen real estate on launch.
  // macOS: show() first (window must be visible before setFullScreen animates);
  //        then setFullScreen(true) triggers the native green-button fullscreen mode.
  // Windows/Linux: maximize() before show() prevents the flash of a smaller window.
  mainWindow.on('ready-to-show', () => {
    if (process.platform === 'darwin') {
      mainWindow!.show()
      mainWindow!.setFullScreen(true)
    } else {
      mainWindow!.maximize()
      mainWindow!.show()
    }
  })

  // Any link that would normally open a new Electron window should open in the system browser
  mainWindow.webContents.setWindowOpenHandler(details => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // In development: load Vite's dev server URL; in production: load the compiled HTML file
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── IPC handlers ───────────────────────────────────────────────────────────────

/**
 * Registers all ipcMain.handle() listeners.
 *
 * Called once during app startup. Each handler corresponds to a method on the
 * `window.electronAPI` object exposed by the preload script. Handlers are
 * grouped by domain: app, docker, scenario, simulation, license, system.
 */
function registerIPCHandlers(): void {
  // ── App metadata ─────────────────────────────────────────────────────────────

  /** Returns version strings displayed in the launch screen and about panel. */
  ipcMain.handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    platform: process.platform as AppInfo['platform'],
    isDev: is.dev
  }))

  /** Opens a URL in the system browser (used for documentation links). */
  ipcMain.handle('app:openExternal', async (_e, { url }: { url: string }) => {
    await shell.openExternal(url)
  })

  /**
   * "Update OTForge" self-updater — supersedes the old scenario-scoped "Update
   * Images" toolbar button (removed). Runs, in order: `git pull` in the project
   * root, `npm install`, then — if a scenario is loaded and Docker is available
   * — a `docker compose pull` for that scenario's images via
   * DockerClient.updateImages(). Only available in dev mode (`npm run dev`
   * from a git checkout); a packaged build has no .git directory or workspace
   * package.json to update.
   *
   * Guards against a dirty working tree: `git status --porcelain --untracked-
   * files=no` catches uncommitted edits to tracked files and an unresolved
   * merge conflict (conflicted files show as `UU` entries), so an instructor's
   * local changes are never silently overwritten. Untracked files are
   * deliberately excluded from this check — `git pull` does not conflict with
   * them (git itself refuses loudly in the rare case an incoming commit would
   * clobber one), and counting them blocks the button forever on froth like a
   * student's own exported scenario sitting in the tracked scenarios/ folder.
   * `git pull` itself is the fallback safety net for anything the porcelain
   * check misses (e.g. diverged history) — it fails loudly rather than
   * force-merging.
   *
   * Whether a restart is actually needed is decided by comparing the git HEAD
   * commit before and after `git pull` — if it moved, source changed and the
   * running process is stale. (electron-vite dev's own file watcher was
   * assumed to auto-restart Electron on a main-process change from `git pull`;
   * confirmed live with a real dev server that it does not, so this handler
   * owns the restart decision entirely rather than relying on that.) When a
   * restart is needed, a native dialog tells the user to run `npm run dev`
   * again, then the app exits right after. Deliberately not spawning `npm run
   * dev` back up automatically — that would mean handing off to a detached
   * process the user can't see the console output of, right as this one
   * disappears; simpler and more transparent to have the user run it
   * themselves. When nothing changed, a native "already up to date" dialog is shown
   * instead and the app keeps running. Progress lines are streamed to the
   * renderer over 'app:updateProgress' throughout.
   *
   * Dependencies are deliberately NOT updated here — this handler only writes
   * the PENDING_DEP_UPDATE_FILE sentinel, and scripts/apply-pending-update.mjs
   * runs the real `npm update` from `predev` on the next launch. npm replaces
   * packages by renaming them, and Windows will not rename a file that the
   * running process holds open, so updating node_modules/electron from inside
   * Electron fails with EBUSY and leaves the install unbootable. See the long
   * comment at the scheduling call below for the full incident.
   */
  ipcMain.handle('app:update', async (_e, scenario?: OTForgeScenario): Promise<AppUpdateResult> => {
    if (!is.dev) {
      return {
        ok: false,
        error:
          'Update OTForge only works when running from a git checkout (npm run dev), not a packaged build.'
      }
    }

    const projectRoot = getProjectRoot()
    const send = (line: string): void => {
      mainWindow?.webContents.send('app:updateProgress', { line })
    }

    try {
      const { stdout } = await execAsync('git status --porcelain --untracked-files=no', {
        cwd: projectRoot
      })
      if (stdout.trim().length > 0) {
        return {
          ok: false,
          error:
            'You have uncommitted local changes in the OTForge repo. Commit, stash, or discard them before updating, then try again.'
        }
      }
    } catch (err) {
      return { ok: false, error: `Could not check git status: ${(err as Error).message}` }
    }

    try {
      const { stdout: beforeHead } = await execAsync('git rev-parse HEAD', { cwd: projectRoot })

      send('Pulling latest source (git pull)...')
      await runStreamedCommand('git', ['pull'], projectRoot, send)

      const { stdout: afterHead } = await execAsync('git rev-parse HEAD', { cwd: projectRoot })
      const restartRequired = beforeHead.trim() !== afterHead.trim()

      // Dependency updates are SCHEDULED here, never performed here.
      //
      // This handler runs inside the live Electron process, which on Windows
      // holds open file handles on node_modules/electron/dist/electron.exe and
      // dist/resources/default_app.asar. npm replaces a package by renaming it,
      // and Windows refuses to rename a file with open handles, so running
      // `npm update` from here aborts with EBUSY (errno -4082) partway through.
      //
      // The abort is what makes it dangerous: it left the tree structurally
      // drifted (electron nested under packages/app/node_modules instead of
      // hoisted to the root, with its dist/ binary gone), and since this repo
      // has no lockfile there was no recorded good state for npm to repair
      // against. A plain `npm install` then reported success while leaving the
      // app unable to start. It took a full node_modules wipe to recover, and
      // it happened to a live classroom.
      //
      // An earlier revision of this code ran `npm update` here on the reasoning
      // that, unlike `rm -rf node_modules`, it "doesn't delete anything." That
      // is not true — re-resolution replaces package directories, including
      // electron's. The verification that passed at the time did so only
      // because re-resolution happened to be a no-op for electron that day.
      //
      // So: drop a sentinel and let scripts/apply-pending-update.mjs run the
      // actual `npm update` from `predev` on the next launch, when Electron is
      // not running and npm is free to replace whatever it likes.
      send('Scheduling dependency update for next startup...')
      await writeFile(
        pathJoin(projectRoot, PENDING_DEP_UPDATE_FILE),
        `${new Date().toISOString()}\n`
      )

      // Tracks the container image pull outcome SEPARATELY from the overall
      // source update — see AppUpdateResult.imageRefresh in packages/schema/
      // src/ipc.ts for why this can't just be folded into `ok`. Every branch
      // below sets exactly one of these two variables so the dialog text can
      // tell the user honestly whether images were actually refreshed.
      let imageRefresh: AppUpdateResult['imageRefresh']
      let imageRefreshError: string | undefined

      if (scenario) {
        const dockerAvailable = await dockerClient.isAvailable()
        if (dockerAvailable) {
          send('Refreshing container images for the loaded scenario...')
          const projectName = toProjectName(scenario.meta.name)
          const zones = await resolveZones()
          const scenarioDir = pathJoin(app.getPath('userData'), 'scenarios', projectName)
          const composeYaml = generateCompose(scenario, projectName, scenarioDir, zones)
          const imageResult = await dockerClient.updateImages(projectName, composeYaml, send)
          if (imageResult.ok) {
            imageRefresh = 'ok'
          } else {
            imageRefresh = 'failed'
            imageRefreshError = imageResult.error
            send(
              `Container image refresh failed: ${imageResult.error} (source update still applied)`
            )
          }
        } else {
          imageRefresh = 'skipped-no-docker'
          send('Docker is not running — skipping container image refresh.')
        }
      } else {
        imageRefresh = 'skipped-no-scenario'
        send('No scenario loaded — skipping container image refresh.')
      }

      // Appended to whichever dialog shows below whenever images were NOT
      // confirmed refreshed, so "up to date"/"restart required" never implies
      // more than what actually happened. Left empty (no addendum) only when
      // imageRefresh === 'ok'.
      const imageRefreshNote =
        imageRefresh === 'skipped-no-scenario'
          ? '\n\nNote: no lab was open, so container images were NOT refreshed. Open a lab and click Update OTForge again to check for newer images.'
          : imageRefresh === 'skipped-no-docker'
            ? '\n\nNote: Docker was not running, so container images were NOT refreshed. Start Docker and click Update OTForge again to check for newer images.'
            : imageRefresh === 'failed'
              ? `\n\nNote: container image refresh FAILED (${imageRefreshError}). Source code is current, but you may still be running outdated containers — try Update OTForge again.`
              : ''

      if (restartRequired) {
        await dialog.showMessageBox(mainWindow!, {
          type: 'info',
          title: 'OTForge Updated',
          message: 'Update downloaded — restart required',
          detail:
            "This update changed OTForge's own code, so it needs to restart to take effect.\n\n" +
            'Click OK, then stop this process (Ctrl+C) and run `npm run dev` again. ' +
            'Dependency updates will be applied automatically during that startup.' +
            imageRefreshNote,
          buttons: ['OK']
        })
        app.exit(0)
      } else {
        // Source was already current, so nothing forces a restart right now.
        // The dependency update is still queued and will be applied on the next
        // normal startup — deliberately NOT forcing a restart for it, since
        // upstream patch releases are routine and interrupting a class for one
        // would be worse than applying it whenever the app next starts.
        await dialog.showMessageBox(mainWindow!, {
          type: 'info',
          title: 'OTForge',
          message: 'OTForge source is already up to date.',
          detail:
            'Dependency updates will be checked and applied the next time you start OTForge.' +
            imageRefreshNote,
          buttons: ['OK']
        })
      }

      return { ok: true, restartRequired, imageRefresh, imageRefreshError }
    } catch (err) {
      return { ok: false, error: `Update failed: ${(err as Error).message}` }
    }
  })

  // ── Docker health check ───────────────────────────────────────────────────────

  /**
   * Checks whether the Docker daemon is running and returns its version.
   *
   * The renderer calls this on mount to enable/disable the Run Simulation button.
   * Error messages are user-facing and tuned for the most common failure mode
   * (Docker Desktop installed but not started).
   */
  ipcMain.handle('docker:check', async (): Promise<DockerStatus> => {
    try {
      const { stdout } = await execAsync('docker version --format "{{.Server.Version}}"', {
        env: buildDockerEnv()
      })
      return { available: true, version: stdout.trim() }
    } catch (err) {
      const msg = (err as Error).message ?? ''
      // Distinguish "not running" from "not installed" for a better error message
      const notRunning =
        msg.includes('pipe') || msg.includes('connect') || msg.includes('Cannot connect')
      return {
        available: false,
        message: notRunning
          ? 'Docker Desktop is not running. Open Docker Desktop from the Start Menu and wait for the whale icon to appear in the system tray.'
          : `Docker error: ${msg}`
      }
    }
  })

  /** Returns the raw `docker --version` string for display in the status bar. */
  ipcMain.handle('docker:version', async (): Promise<string> => {
    try {
      const { stdout } = await execAsync('docker --version', { env: buildDockerEnv() })
      return stdout.trim()
    } catch {
      return 'unavailable'
    }
  })

  // ── Scenario management ───────────────────────────────────────────────────────

  /**
   * Opens a native file picker, reads the selected .otflab file, validates the
   * JSON schema, estimates memory requirements, optionally warns the user, then
   * persists the scenario to LevelDB so it survives an app restart.
   *
   * @returns ScenarioImportResult with the parsed scenario on success, or an
   *   error message string on failure/cancellation.
   */
  ipcMain.handle('scenario:import', async (): Promise<ScenarioImportResult> => {
    // Default to the scenarios library folder so the user lands in the right place.
    // getScenariosLibraryDir() returns the project scenarios/ dir in dev and
    // Documents/OTForge/Scenarios in production.
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Open ICS Scenario',
      defaultPath: getScenariosLibraryDir(),
      filters: [{ name: 'OTForge Scenario', extensions: ['otflab'] }],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'Import cancelled' }
    }

    const chosenPath = result.filePaths[0]

    let raw: unknown
    try {
      raw = JSON.parse(await readFile(chosenPath, 'utf-8'))
    } catch (err) {
      return { ok: false, error: `Failed to parse scenario: ${(err as Error).message}` }
    }

    // Validate JSON structure matches the OTForgeScenario schema
    const { validateScenario: validate } = await import('@otforge/orchestrator')
    const validation = validate(raw)
    if (!validation.valid) {
      return { ok: false, error: `Invalid scenario:\n${validation.errors.join('\n')}` }
    }

    const scenario = raw as OTForgeScenario
    const resourceEstimate = estimateResources(scenario)
    const memCheck = checkSystemMemory(resourceEstimate)

    // Warn if scenario will consume more than 60% of free RAM; block at 85%
    if (memCheck.warningThreshold) {
      const level = memCheck.criticalThreshold ? 'warning' : 'info'
      const { response } = await dialog.showMessageBox(mainWindow!, {
        type: level,
        title: memCheck.criticalThreshold ? 'High Memory Warning' : 'Memory Notice',
        message: `This scenario requires ~${resourceEstimate.estimatedRamMb}MB RAM`,
        detail: `Your system has ${memCheck.freeMb}MB free of ${memCheck.totalMb}MB total.\n\n${
          memCheck.criticalThreshold
            ? 'Your system may become unresponsive. Consider closing other applications first.'
            : 'Performance may be affected. Close other applications if you experience slowness.'
        }`,
        buttons: ['Continue', 'Cancel'],
        // Default to Cancel on critical threshold so users don't accidentally proceed
        defaultId: memCheck.criticalThreshold ? 1 : 0,
        cancelId: 1
      })
      if (response === 1) return { ok: false, error: 'Import cancelled' }
    }

    // Track the file path so scenario:deleteFile knows what to remove.
    activeScenarioFilePath = chosenPath

    await saveActiveScenario(scenario)
    return { ok: true, scenario, resourceEstimate, filePath: chosenPath }
  })

  /**
   * Validates an in-memory scenario object without showing a file picker.
   * Used by the canvas editor to check user-constructed scenarios before export.
   *
   * @param scenario - Any value (typically the canvas's current scenario state).
   * @returns { valid, errors } — errors is an empty array when valid.
   */
  ipcMain.handle('scenario:validate', async (_e, scenario: unknown) => {
    return validateScenario(scenario)
  })

  /**
   * Exports a scenario to a .otflab file.
   *
   * If options.locked is true, the visual layer (node positions) and the security
   * layer (firewall rules, IDS config) are stripped from the output. This produces
   * a "student copy" that cannot be reverse-engineered to extract the full topology.
   *
   * @param scenario - The full scenario object from the canvas.
   * @param options  - Export options including optional target path and locked flag.
   */
  ipcMain.handle(
    'scenario:export',
    async (
      _e,
      { scenario, options }: { scenario: OTForgeScenario; options: ScenarioExportOptions }
    ): Promise<ScenarioExportResult> => {
      let targetPath = options.filePath

      // Show a save dialog if no explicit path was provided.
      // Default to a custom/ subfolder next to the bundled tutorials — visible
      // in the same Open dialog, but never inside the git-tracked scenarios/
      // directory itself. See getScenarioExportDir().
      if (!targetPath) {
        const cleanName = scenario.meta.name.replace(/\s+/g, '-')
        const result = await dialog.showSaveDialog(mainWindow!, {
          title: 'Save ICS Scenario',
          filters: [{ name: 'OTForge Scenario', extensions: ['otflab'] }],
          defaultPath: pathJoin(await getScenarioExportDir(), `${cleanName}.otflab`)
        })
        if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled' }
        targetPath = result.filePath
      }

      // Locked scenarios omit the visual layer (node positions) so students cannot
      // reverse-engineer the full topology. The security layer is replaced with an
      // empty stub so the file passes schema validation on import — the actual
      // firewall rules and IDS config are intentionally hidden from students.
      const exportData = options.locked
        ? {
            ...scenario,
            meta: { ...scenario.meta, locked: true },
            visual: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
            security: { firewallRules: [], idsConfig: { enabled: false, alerts: [] } }
          }
        : scenario

      try {
        await writeFile(targetPath, JSON.stringify(exportData, null, 2), 'utf-8')
        // Track the saved path so scenario:deleteFile knows what to remove later.
        activeScenarioFilePath = targetPath
        return { ok: true, filePath: targetPath }
      } catch (err) {
        return { ok: false, error: `Failed to write scenario: ${(err as Error).message}` }
      }
    }
  )

  /**
   * Deletes the .otflab scenario file at the given path from disk.
   *
   * Called by the renderer's Delete Scenario action after the user confirms.
   * The renderer passes the file path it received from scenario:import or
   * scenario:export. If the path does not exist or cannot be removed, returns
   * { ok: false, error } rather than throwing — the renderer always clears the
   * canvas regardless of whether the file delete succeeds.
   *
   * @param filePath - Absolute path to the .otflab file to remove.
   */
  ipcMain.handle(
    'scenario:deleteFile',
    async (_e, { filePath }: { filePath: string }): Promise<ScenarioDeleteFileResult> => {
      try {
        await rm(filePath, { force: true })
        // Clear the active path so a subsequent deleteFile on the same session
        // can't accidentally re-delete an unrelated file.
        if (activeScenarioFilePath === filePath) {
          activeScenarioFilePath = null
        }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: `Failed to delete scenario: ${(err as Error).message}` }
      }
    }
  )

  // ── Simulation lifecycle ──────────────────────────────────────────────────────

  /**
   * Starts a simulation for a given scenario.
   *
   * Sequence:
   *   1. Verify Docker is reachable.
   *   2. Generate a docker-compose.yml from the scenario device graph.
   *   3. Write the compose file to userData/scenarios/<projectName>/.
   *   4. Run `docker compose up -d` to launch all containers.
   *   5. Wait 2 s for containers to enter the running state.
   *   6. Return the list of container names that came up successfully.
   *
   * @param scenario - The full scenario to simulate.
   * @returns SimulationStartResult with containersStarted list on success.
   */
  ipcMain.handle(
    'simulation:start',
    async (_e, scenario: OTForgeScenario): Promise<SimulationStartResult> => {
      // Top-level try/catch converts any thrown error into a structured { ok: false }
      // result. Without this, an uncaught throw rejects the ipcMain handler's promise,
      // which causes ipcRenderer.invoke() to throw on the renderer side — and since
      // handleStart() in App.tsx had no catch block, simStatus would hang at 'starting'.
      try {
        const dockerAvailable = await dockerClient.isAvailable()
        if (!dockerAvailable) {
          return { ok: false, error: 'Docker Desktop is not running.' }
        }

        const projectName = toProjectName(scenario.meta.name)
        activeProjectName = projectName

        // Build PLC, attack-machine, and workstation port maps with the same iteration order
        // and base ports as compose-generator.ts so the IPC handlers can find host ports
        // without re-parsing the generated compose file.
        activePlcPorts.clear()
        activePlcModbusPorts.clear()
        activeAttackPorts.clear()
        activeWorkstationPorts.clear()
        let plcIdx = 0
        let attackIdx = 0
        let workstationIdx = 0
        for (const [nodeId, device] of Object.entries(scenario.devices.devices)) {
          if (device.category === 'plc' || device.category === 'safety-plc') {
            activePlcPorts.set(nodeId, 18080 + plcIdx)
            // 18550 matches PLC_MODBUS_PORT_BASE in compose-generator.ts
            activePlcModbusPorts.set(nodeId, 18550 + plcIdx)
            plcIdx++
          }
          if (device.category === 'attack-machine') {
            // Base port 6900 matches ATTACK_NOVNC_PORT_BASE in compose-generator.ts
            activeAttackPorts.set(nodeId, 6900 + attackIdx)
            attackIdx++
          }
          if (device.category === 'engineering-workstation') {
            // Base port 6800 matches WORKSTATION_NOVNC_PORT_BASE in compose-generator.ts
            activeWorkstationPorts.set(nodeId, 6800 + workstationIdx)
            workstationIdx++
          }
        }

        // Resolve Docker subnets for all four network zones.
        //
        // resolveZones() reads settings.json: if autoDetect is true (default), it
        // calls findFreeSubnets(getInUseCidrs()) to pick /24 subnets in 10.200–10.210.x
        // that don't conflict with any current host network interface. If the user has
        // pinned specific subnets via the Settings modal, those are used instead.
        //
        // The resolved map is threaded into writeGrafanaProvisioning() (so Grafana
        // datasource URLs point to the correct InfluxDB/Loki IPs) and generateCompose()
        // (so every Docker bridge network and container static IP falls inside the
        // resolved subnets).
        const zones = await resolveZones()
        // Monitoring infrastructure (InfluxDB, Loki, Grafana, FUXA) lives on the
        // Control Center (Level 3) network. Pass its prefix so Grafana datasource
        // URLs in the provisioning files point to the resolved subnet.
        const controlBase = zones.control.subnet.replace('.0/24', '')

        // Write Grafana and Promtail provisioning files to the scenario directory.
        // These must exist before generateCompose() references their paths in volume
        // mounts, and before docker compose up starts the Grafana container.
        const scenarioDir = pathJoin(app.getPath('userData'), 'scenarios', projectName)
        await writeGrafanaProvisioning(scenarioDir, projectName, controlBase)

        const composeYaml = generateCompose(scenario, projectName, scenarioDir, zones)

        // Capture zone subnets so firewall:reload can generate nft rules at runtime.
        activeZones = Object.fromEntries(
          Object.entries(zones).map(([z, cfg]) => [z, cfg.subnet])
        ) as Record<NetworkZone, string>

        // Pass a callback that fires if docker image inspect reveals missing images.
        // The renderer listens for simulation:pullStatus { pulling: true } and shows
        // an "Importing Containers" overlay so the user knows why startup is slow.
        const result = await dockerClient.startScenario(
          projectName,
          composeYaml,
          // onPullNeeded: fires only when Docker is actually downloading layers;
          // type is 'import' (image missing locally) or 'update' (image present, new digest)
          (type: 'import' | 'update') => {
            mainWindow?.webContents.send('simulation:pullStatus', { pulling: true, type })
          },
          // onProgress: stream each output line to the renderer overlay
          (line: string) => {
            mainWindow?.webContents.send('simulation:pullProgress', { line })
          }
        )

        if (!result.ok) {
          activeProjectName = null

          return { ok: false, error: result.error }
        }

        // Brief delay to allow containers to transition from "created" to "running"
        // before we poll their status for the success report
        await new Promise(resolve => setTimeout(resolve, 2000))
        const statuses = await dockerClient.getStatus(projectName)
        const started = statuses.filter(s => s.status === 'running').map(s => s.nodeId)

        // Wire PLC → HMI: auto-provision Modbus device connections in FUXA
        // so the HMI displays live process data without any manual configuration.
        // Fire-and-forget — FUXA may still be pulling its image; configureFuxa()
        // retries internally and logs failures without blocking the start response.
        configureFuxa(scenario).catch(() => {
          // configureFuxa() logs its own errors; swallow here so ipcMain.handle
          // never rejects (a rejected promise in a fire-and-forget would surface
          // as an unhandled rejection and crash the main process in Electron).
        })

        // Pre-install networking tools in the Kali attack machine container.
        // Fire-and-forget — runs in the background while the renderer shows "running".
        configureAttackMachine().catch(() => {})

        // Create the per-lab "…_Student_Saved_Work" folder on the workstation so
        // students have a known place to keep work that Save Session preserves.
        // Fire-and-forget — runs after the desktop finishes booting.
        configureWorkstationSaveFolder(scenario).catch(() => {})

        return { ok: true, containersStarted: started }
      } catch (err) {
        // Reset active project so a retry doesn't think a simulation is already running
        activeProjectName = null
        activePlcPorts.clear()
        activePlcModbusPorts.clear()
        activeAttackPorts.clear()
        activeWorkstationPorts.clear()
        return { ok: false, error: `Simulation start failed: ${(err as Error).message}` }
      }
    }
  )

  /**
   * Stops the running simulation and cleans up the active project reference.
   *
   * Runs `docker compose down --volumes` which removes containers AND their
   * anonymous volumes, returning the environment to a clean state.
   * The LevelDB active-scenario key is cleared so the next app launch starts fresh.
   */
  ipcMain.handle('simulation:stop', async (): Promise<SimulationStopResult> => {
    if (!activeProjectName) return { ok: false, error: 'No simulation is running' }

    // Kill any open terminal session before tearing down the containers
    if (activeTerminalProcess) {
      activeTerminalProcess.kill()
      activeTerminalProcess = null
    }

    const result = await dockerClient.stopScenario(activeProjectName)
    if (result.ok) {
      await clearActiveScenario()
      activeProjectName = null
      activeZones = null
      activePlcPorts.clear()
      activePlcModbusPorts.clear()
      activeAttackPorts.clear()
      activeWorkstationPorts.clear()
    }
    return result
  })

  /**
   * Returns the current container health/state for all containers in the active simulation.
   * Returns an empty array when no simulation is running (renderer uses this to clear the UI).
   */
  ipcMain.handle('simulation:status', async (): Promise<ContainerStatus[]> => {
    if (!activeProjectName) return []
    return dockerClient.getStatus(activeProjectName)
  })

  // ── Session save / load ───────────────────────────────────────────────────────
  /**
   * Saves the student's current session so a lab can be resumed later. Persists
   * the scenario (which carries their edited Suricata/firewall rules) and the
   * tutorial step to <userData>/sessions/<projectName>/. Keyed by scenario name,
   * so re-saving the same lab overwrites its one session. A later increment also
   * captures the student's Lab_NN_Student_Saved_Work folder into this directory.
   */
  ipcMain.handle(
    'session:save',
    async (
      _e,
      { scenario, tutorialStep }: { scenario: OTForgeScenario; tutorialStep: number }
    ): Promise<SessionSaveResult> => {
      try {
        const projectName = toProjectName(scenario.meta.name)
        await saveSession(app.getPath('userData'), {
          projectName,
          scenarioName: scenario.meta.name,
          savedAt: new Date().toISOString(),
          tutorialStep,
          scenario
        })
        // Best-effort capture of the student's Lab_NN_Student_Saved_Work folder
        // (only succeeds while the workstation is running); never fails the save.
        await captureLabFolder(scenario, projectName)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: `Failed to save session: ${(err as Error).message}` }
      }
    }
  )

  /** Lists all saved sessions (summaries, newest first) for the Load picker. */
  ipcMain.handle('session:list', async (): Promise<SessionSummary[]> => {
    try {
      return await listSessions(app.getPath('userData'))
    } catch {
      return []
    }
  })

  /**
   * Loads a saved session by project name, returning the scenario and the tutorial
   * step to resume at. The renderer applies the scenario and jumps to that step.
   */
  ipcMain.handle(
    'session:load',
    async (_e, { projectName }: { projectName: string }): Promise<SessionLoadResult> => {
      try {
        const session = await loadSession(app.getPath('userData'), projectName)
        if (!session) return { ok: false, error: 'No saved session found.' }
        // Arm the one-shot restore: the next simulation start for this project
        // copies the saved lab-work folder back into the workstation.
        pendingSessionRestore = projectName
        return { ok: true, scenario: session.scenario, tutorialStep: session.tutorialStep }
      } catch (err) {
        return { ok: false, error: `Failed to load session: ${(err as Error).message}` }
      }
    }
  )

  // ── Firewall runtime reload ───────────────────────────────────────────────────

  /**
   * Rebuilds the nftables forward chain in the running firewall container without
   * restarting the simulation. Students add/remove rules in the UI then click
   * "Apply Rules" to push them live.
   *
   * How it works — no image rebuild required:
   *   buildNftScript() converts the typed ACLRule array into a sequence of plain
   *   `nft` shell commands. That script is piped via stdin to
   *   `docker exec -i <container> sh` — the container already has sh and nft.
   *   Zone subnets come from activeZones, captured when the simulation started.
   *
   * @param nodeId        - Canvas node ID of the firewall device.
   * @param rules         - Current ACLRule array from scenario.security.firewallRules.
   * @param defaultPolicy - "drop" (deny-by-default) or "accept" (allow-by-default).
   */
  ipcMain.handle(
    'firewall:reload',
    (
      _e,
      { nodeId, rules, defaultPolicy }: { nodeId: string; rules: ACLRule[]; defaultPolicy: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!activeProjectName || !activeZones) {
        return Promise.resolve({ ok: false, error: 'No simulation running.' })
      }
      const sanitized = nodeId.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      const containerName = `${activeProjectName}-${sanitized}`
      const script = buildNftScript(rules, defaultPolicy, activeZones)

      return new Promise(resolve => {
        const proc = spawn('docker', ['exec', '-i', containerName, 'sh'], {
          env: buildDockerEnv(),
          stdio: 'pipe'
        })
        let stderr = ''
        proc.stderr?.on('data', chunk => {
          stderr += chunk.toString()
        })
        proc.stdin?.write(script)
        proc.stdin?.end()
        proc.on('close', code =>
          resolve(code === 0 ? { ok: true } : { ok: false, error: stderr || `exit ${code}` })
        )
        proc.on('error', err => resolve({ ok: false, error: err.message }))
      })
    }
  )

  // ── IDS custom rule check ─────────────────────────────────────────────────────

  /**
   * Checks custom Suricata rules when the student clicks Save in the IDS panel, by
   * running the real `suricata -T` in a throwaway container from the sensor image.
   * Works with or without a running simulation. See suricata-rules.ts for why.
   *
   * @param rules - Custom rules text exactly as it will be saved (trimmed), so the
   *                line numbers in the result match what the panel shows.
   */
  ipcMain.handle(
    'ids:validateRules',
    (_e, { rules }: { rules: string }): Promise<SuricataRuleCheckResult> =>
      dockerClient.validateSuricataRules(rules)
  )

  // ── Monitoring — Loki log query proxy (Phase 6) ───────────────────────────────

  /**
   * Proxies a Loki HTTP query_range request from the renderer to the local Loki
   * container (localhost:3100). Running the request in the main process avoids
   * CORS and Content-Security-Policy issues that would arise if the renderer
   * fetched directly from an HTTP origin different from its own page origin.
   *
   * The caller passes a LogQL query string and a time range in nanoseconds.
   * Results are returned as the raw Loki API JSON object — the renderer is
   * responsible for parsing the streams/values structure.
   *
   * @param query  - LogQL expression, e.g. '{job="suricata"} | json | event_type="alert"'
   * @param fromNs - Range start as a nanosecond Unix timestamp string.
   * @param toNs   - Range end as a nanosecond Unix timestamp string.
   * @param limit  - Maximum number of log lines to return (default 200).
   */
  ipcMain.handle(
    'monitor:getLogs',
    (
      _e,
      {
        query,
        fromNs,
        toNs,
        limit = 200
      }: { query: string; fromNs: string; toNs: string; limit?: number }
    ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
      return new Promise(resolve => {
        const params = new URLSearchParams({
          query,
          start: fromNs,
          end: toNs,
          limit: String(limit),
          direction: 'backward'
        })
        const reqUrl = `http://localhost:3100/loki/api/v1/query_range?${params}`
        const req = http.get(reqUrl, res => {
          let body = ''
          res.on('data', (chunk: Buffer) => (body += chunk.toString()))
          res.on('end', () => {
            try {
              resolve({ ok: true, data: JSON.parse(body) })
            } catch {
              resolve({ ok: false, error: 'Invalid JSON response from Loki' })
            }
          })
        })
        req.on('error', (err: Error) => resolve({ ok: false, error: err.message }))
        // 5 s timeout — Loki should respond immediately; if not, it hasn't started yet
        req.setTimeout(5000, () => {
          req.destroy()
          resolve({ ok: false, error: 'Loki request timed out — container may still be starting' })
        })
      })
    }
  )

  // ── Monitoring — Grafana readiness probe ──────────────────────────────────────

  /**
   * Checks whether the Grafana HTTP server is fully started and accepting requests
   * by probing localhost:3000/api/health. The MonitorPanel polls this before
   * rendering the <webview> to avoid the "ERR_CONNECTION_REFUSED" error that
   * occurs when the Grafana container hasn't finished its startup sequence.
   *
   * @returns true if Grafana responds with HTTP 2xx; false on any error or timeout.
   */
  ipcMain.handle('monitor:grafanaReady', (): Promise<boolean> => {
    return new Promise(resolve => {
      const req = http.get('http://localhost:3000/api/health', { timeout: 2000 }, res => {
        // Any 2xx status means Grafana is up and serving requests
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300)
        res.resume() // drain the response body so the socket can be reused
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
    })
  })

  // ── Monitoring — open Grafana in a separate OS window ────────────────────────

  /**
   * Opens the Grafana ICS Lab Overview dashboard in a standalone Electron
   * BrowserWindow rather than embedding it in the MonitorPanel drawer webview.
   *
   * A dedicated window lets students undock Grafana to a second monitor, resize
   * it independently of the main simulator, and interact with all Grafana features
   * (Explore, variable controls, time range picker) without being constrained by
   * the drawer height.
   *
   * The window opens at 1400×900 — large enough to show the two-column dashboard
   * layout without horizontal scrolling on a 1920×1080 display.
   *
   * If Grafana is not yet ready (port 3000 not open) the window still opens;
   * Grafana's own loading screen handles the transient connection state.
   *
   * @returns { ok: true } on success; { ok: false, error } if no simulation is running.
   */
  ipcMain.handle('monitor:openGrafana', async (): Promise<{ ok: boolean; error?: string }> => {
    if (!activeProjectName) {
      return { ok: false, error: 'No simulation is running.' }
    }

    const grafanaWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      title: 'Grafana — ICS Lab Overview',
      autoHideMenuBar: true,
      // Dark background matches Grafana's dark theme and prevents white flash on load
      backgroundColor: '#111217',
      webPreferences: {
        // Full sandbox — Grafana is a third-party web app with no Electron APIs needed
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false
      }
    })

    // Load with dark theme, 5 s auto-refresh; omit kiosk so the full nav is available
    grafanaWindow.loadURL('http://localhost:3000/d/ics-overview?orgId=1&theme=dark&refresh=5s')

    // Prevent Grafana from spawning pop-out windows that bypass our sandbox settings
    grafanaWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    return { ok: true }
  })

  // ── PLC IDE — live program deployment (Phase 4) ───────────────────────────────

  /**
   * Uploads a Structured Text program to a running OpenPLC container and
   * triggers recompilation + PLC restart.
   *
   * Workflow:
   *   1. Look up the OpenPLC container's published host port from activePlcPorts.
   *   2. POST credentials to /login to obtain a Flask session cookie.
   *   3. POST the ST source as a multipart file upload to /upload-program.
   *   4. GET /start_plc to compile and begin execution.
   *   5. Return the compiler output for display in the PlcIdePanel status area.
   *
   * If no simulation is running (activePlcPorts is empty), returns a notice
   * telling the user to restart the simulation to apply the saved program.
   *
   * OpenPLC default credentials are openplc / openplc (set during install.sh).
   * These are intentionally insecure defaults for lab use — in production ICS
   * environments, credentials would be rotated and the web interface would be
   * isolated behind a VLAN.
   *
   * @param nodeId - Canvas node ID of the target PLC device.
   * @param source - Decoded ST source text (not base64 — the preload decodes it).
   */
  ipcMain.handle(
    'plc:deploy',
    async (
      _e,
      { nodeId, source }: { nodeId: string; source: string }
    ): Promise<PLCDeployResult> => {
      // If no simulation is running, the program can only be pre-loaded at next start
      if (!activeProjectName || activePlcPorts.size === 0) {
        return {
          ok: true,
          output: 'Program saved to scenario. Restart simulation to deploy to PLC container.'
        }
      }

      const hostPort = activePlcPorts.get(nodeId)
      if (!hostPort) {
        return {
          ok: false,
          error: `No running OpenPLC container found for device "${nodeId}". Check simulation status.`
        }
      }

      try {
        return await deployToOpenPLC(hostPort, source, nodeId)
      } catch (err) {
        return { ok: false, error: `Deploy error: ${(err as Error).message}` }
      }
    }
  )

  /**
   * Polls the OpenPLC Runtime's web interface to determine whether the PLC
   * is actively executing a program or is stopped/idle.
   *
   * Makes a lightweight GET request to the /dashboard endpoint and inspects
   * the response HTML for the "PLC Status" indicator text. Returns running=false
   * if the request fails (container not yet ready, network not available, etc.).
   *
   * @param nodeId - Canvas node ID of the PLC device to query.
   */
  ipcMain.handle(
    'plc:status',
    async (_e, { nodeId }: { nodeId: string }): Promise<PLCRuntimeStatus> => {
      const hostPort = activePlcPorts.get(nodeId)
      if (!hostPort) {
        return { nodeId, running: false, error: 'No active container for this device' }
      }

      try {
        const body = await httpGet(`http://localhost:${hostPort}/dashboard`)
        // OpenPLC dashboard HTML contains "PLC Status: Running" or "PLC Status: Stopped"
        const running = body.includes('Running') && !body.includes('PLC Status: Stopped')
        return { nodeId, running }
      } catch {
        return { nodeId, running: false }
      }
    }
  )

  /**
   * Opens the OpenPLC Runtime web interface for the given device in the user's
   * default browser, enabling access to Ladder Logic editing, monitoring, and
   * all features of the native OpenPLC IDE that are not exposed in the built-in
   * ST editor.
   *
   * The URL is http://localhost:{hostPort} where hostPort is the host-published
   * port from activePlcPorts (base 18080, incremented per PLC in scenario order).
   * Default OpenPLC credentials: openplc / openplc
   *
   * @param nodeId - Canvas node ID of the target PLC device.
   */
  ipcMain.handle('plc:openWebUI', async (_e, { nodeId }: { nodeId: string }) => {
    const hostPort = activePlcPorts.get(nodeId)
    if (!hostPort) return
    await shell.openExternal(`http://localhost:${hostPort}`)
  })

  // ── Modbus coil polling — live pipe-flow animation ────────────────────────────

  /**
   * Reads a block of coil states from a PLC via Modbus TCP and returns them as
   * a boolean array. Called by ScadaCanvas's coil-polling useEffect (every 2 s)
   * to drive the pipe-flow animation in the OT layer canvas.
   *
   * Implementation: raw Modbus TCP via Node.js net module (no third-party library).
   * Connects to localhost:${activePlcModbusPorts.get(nodeId)} — the PLC Modbus port
   * published by compose-generator.ts (base 18550). Sends FC01 Read Coils MBAP
   * frame, parses the response bit-fields into a boolean[].
   *
   * Returns [] (empty array) on connection failure so the canvas keeps the last
   * known coil state rather than resetting to undefined.
   *
   * @param nodeId - Scenario device node ID of the target PLC.
   * @param count  - Number of coils to read starting at address 0.
   */
  ipcMain.handle(
    'modbus:readCoils',
    async (_e, { nodeId, count }: { nodeId: string; count: number }): Promise<boolean[]> => {
      const hostPort = activePlcModbusPorts.get(nodeId)
      if (!hostPort) return []

      return new Promise<boolean[]>(resolve => {
        const socket = new net.Socket()
        const TIMEOUT_MS = 2500

        // Non-fatal failure path: always resolve (never reject) so the renderer
        // never needs to catch a promise rejection in the polling loop.
        const fail = () => {
          if (!socket.destroyed) socket.destroy()
          resolve([])
        }

        socket.setTimeout(TIMEOUT_MS)
        socket.once('error', fail)
        socket.once('timeout', fail)

        socket.connect(hostPort, '127.0.0.1', () => {
          // Build Modbus TCP FC01 (Read Coils) request frame — 12 bytes total.
          // MBAP header (7 bytes):
          //   [0-1] Transaction ID = 1  (any non-zero value; echoed in response)
          //   [2-3] Protocol ID   = 0  (always 0 for Modbus TCP)
          //   [4-5] Length        = 6  (bytes after Length: Unit ID + 5 PDU bytes)
          //   [6]   Unit ID       = 1  (OpenPLC default slave ID)
          // PDU (5 bytes):
          //   [7]   Function Code = 0x01 (Read Coils)
          //   [8-9] Start Address = 0   (coil 0)
          //   [10-11] Quantity    = count
          const req = Buffer.alloc(12)
          req.writeUInt16BE(1, 0) // Transaction ID
          req.writeUInt16BE(0, 2) // Protocol ID
          req.writeUInt16BE(6, 4) // Length (6 bytes: unit + function + 2 addr + 2 qty)
          req.writeUInt8(1, 6) // Unit ID = 1
          req.writeUInt8(0x01, 7) // Function Code: Read Coils
          req.writeUInt16BE(0, 8) // Starting Address: 0
          req.writeUInt16BE(count, 10) // Quantity of Coils
          socket.write(req)
        })

        // Accumulate response chunks until the full frame arrives.
        // Cast to Buffer — socket encoding is not set so data arrives as Buffer, not string.
        const chunks: Buffer[] = []
        socket.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          const data = Buffer.concat(chunks)
          // Response: 7-byte MBAP + 1 function code + 1 byte count + ceil(count/8) coil bytes
          const coilByteCount = Math.ceil(count / 8)
          const expectedLen = 9 + coilByteCount
          if (data.length < expectedLen) return // wait for more data
          socket.destroy()
          // Check for Modbus exception (function code | 0x80)
          if ((data[7] & 0x80) !== 0) {
            resolve([])
            return
          }
          // Parse coil bits: each byte holds 8 coils, LSB first.
          const coilBytes = data.slice(9, 9 + coilByteCount)
          const coils: boolean[] = []
          for (let i = 0; i < count; i++) {
            const byteIdx = Math.floor(i / 8)
            const bitIdx = i % 8
            coils.push((coilBytes[byteIdx] & (1 << bitIdx)) !== 0)
          }
          resolve(coils)
        })
      })
    }
  )

  /**
   * Reads holding registers from a PLC via Modbus TCP FC03 (Read Holding Registers).
   *
   * Used by ScadaCanvas to poll tank_level (HR 0) for the Water Tank fill-level animation.
   * Mirrors the modbus:readCoils handler but sends FC03 and returns uint16 values.
   *
   * @param nodeId - Scenario device node ID of the target PLC.
   * @param count  - Number of holding registers to read starting at address 0.
   */
  ipcMain.handle(
    'modbus:readHoldingRegisters',
    async (_e, { nodeId, count }: { nodeId: string; count: number }): Promise<number[]> => {
      const hostPort = activePlcModbusPorts.get(nodeId)
      if (!hostPort) return []

      return new Promise<number[]>(resolve => {
        const socket = new net.Socket()
        const TIMEOUT_MS = 2500

        const fail = () => {
          if (!socket.destroyed) socket.destroy()
          resolve([])
        }

        socket.setTimeout(TIMEOUT_MS)
        socket.once('error', fail)
        socket.once('timeout', fail)

        socket.connect(hostPort, '127.0.0.1', () => {
          // Modbus TCP FC03 (Read Holding Registers) request — 12 bytes.
          // MBAP header (7 bytes): Transaction ID=1, Protocol=0, Length=6, Unit=1
          // PDU (5 bytes): FC=0x03, Start Address=0x0000, Quantity=count
          const req = Buffer.alloc(12)
          req.writeUInt16BE(1, 0) // Transaction ID
          req.writeUInt16BE(0, 2) // Protocol ID
          req.writeUInt16BE(6, 4) // Length
          req.writeUInt8(1, 6) // Unit ID = 1
          req.writeUInt8(0x03, 7) // Function Code: Read Holding Registers
          // OpenPLC Runtime maps %QW output words to Modbus HR starting at address 0.
          // tank_level is declared AT %QW0, so it lives at HR 0.
          req.writeUInt16BE(0, 8) // Starting Address: 0 (%QW0 in OpenPLC)
          req.writeUInt16BE(count, 10) // Quantity of Registers
          socket.write(req)
        })

        // FC03 response: 9-byte header + 2 bytes per register
        const chunks: Buffer[] = []
        socket.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          const data = Buffer.concat(chunks)
          const expectedLen = 9 + count * 2
          if (data.length < expectedLen) return
          socket.destroy()
          // Modbus exception response: function code | 0x80
          if ((data[7] & 0x80) !== 0) {
            resolve([])
            return
          }
          // Parse register values: 2 bytes each, big-endian unsigned 16-bit
          const regs: number[] = []
          for (let i = 0; i < count; i++) {
            regs.push(data.readUInt16BE(9 + i * 2))
          }
          resolve(regs)
        })
      })
    }
  )

  /**
   * Writes a single coil to a PLC via Modbus TCP FC05 (Write Single Coil).
   *
   * FC05 writes through the OpenPLC glue pointer directly to the IEC variable,
   * so the PLC program sees the change in its next scan cycle (every 500 ms).
   * This is the correct control path — the OpenPLC IDE "force" feature only
   * overrides the output buffer that Modbus reads, not the internal IEC variable
   * the program computes with.
   *
   * Used by ScadaCanvas to let instructors toggle coil states directly from the
   * OT layer canvas by clicking a coil-bound pipe edge.
   *
   * @param nodeId    - Scenario device node ID of the target PLC.
   * @param coilIndex - Coil address (0 = %QX0.0 = pump_run, 1 = %QX0.1 = valve_open).
   * @param value     - Desired coil state (true = ON, false = OFF).
   */
  ipcMain.handle(
    'modbus:writeCoil',
    async (
      _e,
      { nodeId, coilIndex, value }: { nodeId: string; coilIndex: number; value: boolean }
    ): Promise<{ ok: boolean; error?: string }> => {
      const hostPort = activePlcModbusPorts.get(nodeId)
      if (!hostPort) return { ok: false, error: 'PLC not in active simulation' }

      return new Promise<{ ok: boolean; error?: string }>(resolve => {
        const socket = new net.Socket()
        const TIMEOUT_MS = 2500

        const fail = (err?: Error) => {
          if (!socket.destroyed) socket.destroy()
          resolve({ ok: false, error: err?.message ?? 'connection failed' })
        }

        socket.setTimeout(TIMEOUT_MS)
        socket.once('error', fail)
        socket.once('timeout', () => fail(new Error('timeout')))

        socket.connect(hostPort, '127.0.0.1', () => {
          // Modbus TCP FC05 (Write Single Coil) request — 12 bytes.
          // MBAP header (7 bytes): Transaction ID=2, Protocol=0, Length=6, Unit=1
          // PDU (5 bytes): FC=0x05, Coil Address, Value (0xFF00=ON, 0x0000=OFF)
          const req = Buffer.alloc(12)
          req.writeUInt16BE(2, 0) // Transaction ID
          req.writeUInt16BE(0, 2) // Protocol ID
          req.writeUInt16BE(6, 4) // Length
          req.writeUInt8(1, 6) // Unit ID = 1
          req.writeUInt8(0x05, 7) // Function Code: Write Single Coil
          req.writeUInt16BE(coilIndex, 8) // Output address (coil index)
          req.writeUInt16BE(value ? 0xff00 : 0x0000, 10) // Output value
          socket.write(req)
        })

        socket.once('data', (data: Buffer) => {
          socket.destroy()
          // FC05 success: server echoes the request (8 bytes minimum, FC=0x05)
          if (data.length >= 8 && data[7] === 0x05) {
            resolve({ ok: true })
          } else if (data.length >= 8 && (data[7] & 0x80) !== 0) {
            // Exception response: FC|0x80, exception code at byte 8
            resolve({ ok: false, error: `Modbus exception code ${data[8]}` })
          } else {
            resolve({ ok: false, error: 'unexpected response' })
          }
        })
      })
    }
  )

  // ── Attack terminal ───────────────────────────────────────────────────────────

  /**
   * Opens an interactive bash session in the attack machine container.
   *
   * Why Python pty.spawn instead of docker exec -it:
   *   docker exec requires a pseudo-TTY on BOTH ends of the connection. Electron's
   *   child_process.spawn() uses pipes (not a PTY) on the host side, so docker
   *   exec -t fails or produces no echo. Without a PTY:
   *     - bash does not echo typed characters back to stdout — the terminal looks blank
   *     - bash's readline does not activate — line editing and arrow keys are broken
   *     - pasted text writes to stdin silently without appearing on screen
   *
   *   The fix: run python3 inside the Kali container. Python's `pty.spawn()` creates
   *   a PTY pair entirely INSIDE the container — bash runs as the PTY slave (getting
   *   full interactive behavior, echo, colors, readline). Python proxies between the
   *   PTY master and its own stdin/stdout, which ARE the docker exec pipes.
   *
   *   Data flow:
   *     Host stdin pipe → docker exec → python3 → PTY master write → bash PTY slave
   *     bash output → PTY slave → PTY master read → python3 → docker exec → host stdout
   *
   *   Python3 is installed in the attack-base container (Layer 6 of the Dockerfile).
   *   COLUMNS/LINES are passed so bash knows the terminal dimensions from the start.
   *
   * Only one terminal session is active at a time. Opening a second session
   * automatically closes the previous one.
   *
   * @param nodeId - Canvas node ID of the attack-machine device to exec into.
   */
  ipcMain.handle('terminal:open', async (e, { nodeId }: { nodeId: string }) => {
    const sanitized = nodeId.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const containerName = `${activeProjectName}-${sanitized}`

    // Kill any existing session before starting a new one
    if (activeTerminalProcess) {
      activeTerminalProcess.kill()
      activeTerminalProcess = null
    }

    // python3 -c 'import pty; pty.spawn(...)' allocates a PTY inside the container
    // so bash runs interactively with full echo, readline, and color support.
    // stty sane resets any leftover terminal state before handing off to bash.
    const ptyBridge = [
      'python3',
      '-c',
      'import pty,os; os.environ["COLUMNS"]="220"; os.environ["LINES"]="50"; pty.spawn(["/bin/bash", "-l"])'
    ]

    const proc = spawn(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'TERM=xterm-256color',
        '-e',
        'COLORTERM=truecolor',
        containerName,
        ...ptyBridge
      ],
      { env: buildDockerEnv(), stdio: 'pipe' }
    )

    activeTerminalProcess = proc

    // Route terminal:data events back to the window that called terminal:open.
    // This can be either the standalone terminal BrowserWindow (attack:openTerminalWindow)
    // or the main window's AttackTerminalModal — both call terminal:open via their own
    // preload, and e.sender identifies the correct recipient.
    const callerWindow = BrowserWindow.fromWebContents(e.sender)
    const sendData = (data: string): void => {
      if (callerWindow && !callerWindow.isDestroyed()) {
        callerWindow.webContents.send('terminal:data', data)
      }
    }

    proc.stdout?.on('data', (chunk: Buffer) => sendData(chunk.toString()))
    proc.stderr?.on('data', (chunk: Buffer) => sendData(chunk.toString()))

    proc.on('close', code => {
      sendData(`\r\n[session closed — exit code ${code}]\r\n`)
      if (activeTerminalProcess === proc) activeTerminalProcess = null
    })

    return { ok: true, containerName }
  })

  /**
   * Writes a keystroke or paste payload to the active terminal's stdin.
   * Called by the renderer's xterm.js onData handler for every key press.
   *
   * @param data - Raw string from xterm.js onData (may include escape sequences).
   */
  ipcMain.handle('terminal:write', (_e, { data }: { data: string }) => {
    if (activeTerminalProcess?.stdin) {
      activeTerminalProcess.stdin.write(data)
    }
  })

  /**
   * Closes the active terminal session and kills the docker exec process.
   * Called when the AttackTerminalModal is closed.
   */
  ipcMain.handle('terminal:close', () => {
    if (activeTerminalProcess) {
      activeTerminalProcess.kill()
      activeTerminalProcess = null
    }
  })

  /**
   * Reads the system clipboard and returns its plain-text content.
   *
   * The renderer cannot call navigator.clipboard.readText() reliably from inside
   * xterm.js because Electron may not grant clipboard-read permission to the
   * renderer context. This handler uses Electron's native clipboard module instead,
   * which works unconditionally in the main process.
   *
   * Called by AttackTerminalModal.tsx → attachCustomKeyEventHandler on Ctrl+V so
   * that clipboard text is pasted into the docker exec stdin via term.paste().
   */
  ipcMain.handle('clipboard:readText', () => {
    return clipboard.readText()
  })

  /**
   * Writes a plain-text string to the system clipboard via Electron's native
   * clipboard module.
   *
   * navigator.clipboard.writeText() requires the 'clipboard-write' permission and
   * may fail silently in Electron renderer contexts (non-HTTPS origin). Using the
   * native module guarantees the OS clipboard receives the text so that Ctrl+V in
   * the attack terminal (clipboard:readText path) always finds the expected content.
   *
   * Called by TutorialPanel.tsx → handleCopy so copied commands paste correctly
   * into the docker exec stdin.
   */
  ipcMain.handle('clipboard:writeText', (_event, { text }: { text: string }) => {
    clipboard.writeText(text)
  })

  /**
   * Returns the localhost URL for the noVNC web interface of the given attack
   * machine device. The URL points to the websockify bridge running inside the
   * container at the host-published port tracked in activeAttackPorts.
   *
   * @param nodeId - Canvas node ID of the attack-machine device.
   * @returns { url } on success, { error } if the simulation is not running
   *   or the device is not found in the active port map.
   */
  ipcMain.handle('terminal:getVncUrl', (_e, { nodeId }: { nodeId: string }) => {
    const port = activeAttackPorts.get(nodeId)
    if (!port) {
      return { error: 'No noVNC port found — is the simulation running?' }
    }
    // noVNC v1.5.0 (otforge-attack-base) serves vnc.html at /opt/novnc/ via websockify.
    // ?autoconnect=true  — connect immediately without the manual "Connect" button click
    // ?resize=scale      — scale the 1920×1080 Kali desktop to fit the webview/window
    // Without autoconnect the page loads the connect form but the user has no way to
    // know the correct WebSocket path, causing "cannot connect to server" errors.
    return { url: `http://localhost:${port}/vnc.html?autoconnect=true&resize=scale` }
  })

  // ── License (Phase 12 stubs) ──────────────────────────────────────────────────
  // Real license validation is implemented in Phase 12. During development,
  // these stubs return a permissive dev-mode grant so all features are accessible.
  ipcMain.handle('license:validate', async () => ({
    valid: true,
    userId: 'dev-mode',
    packScopes: ['*'] // '*' grants access to all scenario packs
  }))
  ipcMain.handle('license:info', async () => ({
    valid: true,
    userId: 'dev-mode',
    packScopes: ['*']
  }))

  // ── Scenario restoration ──────────────────────────────────────────────────────
  // If the app was closed while a scenario was active (e.g., app crash or system
  // shutdown), restore it to the renderer after the window finishes loading.
  // The 'did-finish-load' event ensures the renderer's event listener is ready.
  loadActiveScenario().then(scenario => {
    if (scenario && mainWindow) {
      mainWindow.webContents.on('did-finish-load', () => {
        mainWindow!.webContents.send('scenario:restored', scenario)
      })
    }
  })

  // ── System info ───────────────────────────────────────────────────────────────
  /** Returns host memory and CPU count for the resource estimator display. */
  ipcMain.handle('system:meminfo', async () => ({
    totalMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMb: getAvailableMemMb(),
    cpus: os.cpus().length
  }))

  // ── Network settings ──────────────────────────────────────────────────────────

  /**
   * Returns the current NetworkSettings from <userData>/settings.json.
   * Returns { autoDetect: true } on first launch (file not yet created).
   */
  ipcMain.handle('settings:get', async (): Promise<NetworkSettings> => {
    return readSettings()
  })

  /**
   * Persists updated NetworkSettings to <userData>/settings.json.
   * Called when the user clicks Save in the Settings modal.
   *
   * @param settings - Updated settings object from the renderer.
   * @returns { ok: true } on success, { ok: false, error } on write failure.
   */
  ipcMain.handle(
    'settings:set',
    async (_e, settings: NetworkSettings): Promise<{ ok: boolean; error?: string }> => {
      try {
        await writeSettings(settings)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /**
   * Runs subnet auto-detection against the current host network interfaces and
   * returns the computed zone → subnet/gateway map.
   *
   * Called by the Settings modal "Detect" button so users can preview which
   * subnets would be chosen before enabling auto-detect or saving pinned values.
   *
   * Does NOT write to settings.json — the user must click Save to persist.
   *
   * @returns { ok: true, zones } on success where zones is the full zone map.
   */
  ipcMain.handle(
    'settings:detectSubnets',
    (): { ok: boolean; zones?: Record<string, { subnet: string; gateway: string }> } => {
      try {
        const zones = findFreeSubnets(getInUseCidrs())
        return { ok: true, zones }
      } catch {
        return { ok: false }
      }
    }
  )

  // ── Attack Machine window ──────────────────────────────────────────────────────

  /**
   * Opens the attack machine's Kali Linux Xfce4 desktop in a separate Electron
   * BrowserWindow loading the container's noVNC WebSocket interface.
   *
   * The window is a fully independent OS-level window: it can be moved to a second
   * monitor, resized, and operated independently of the main OTForge window.
   * This is intentional — instructors typically put the attack machine on a
   * projector or second display while students view the SCADA canvas on the main screen.
   *
   * noVNC URL parameters:
   *   autoconnect=true — immediately connects to the VNC server without a button click
   *   resize=scale     — scales the Kali desktop to fill the window without scrollbars
   *   No password param — VNC runs with SecurityTypes None inside Docker's isolated network
   *
   * Window security:
   *   sandbox: true + nodeIntegration: false — the noVNC page runs in a fully sandboxed
   *   renderer with no Electron or Node.js access. This is safe because the noVNC page
   *   is served by the Kali container over localhost; it cannot reach the host filesystem.
   *
   * @param nodeId - Canvas node ID of the attack-machine device to open.
   * @returns { ok: true } on success, { ok: false, error } if the simulation is not
   *   running or the device's port mapping was not found.
   */
  ipcMain.handle(
    'attack:launchWindow',
    async (_e, { nodeId }: { nodeId: string }): Promise<{ ok: boolean; error?: string }> => {
      const port = activeAttackPorts.get(nodeId)
      if (!port) {
        return {
          ok: false,
          error: 'No noVNC port found for this attack machine — is the simulation running?'
        }
      }

      // Probe the noVNC websockify port before opening the window.
      // If the container is still starting (image pull, OS boot, VNC server init),
      // the port will be closed and we return a clear message instead of opening a
      // window that immediately shows a "Connection refused" or noVNC error page.
      const ready = await isPortOpen(port)
      if (!ready) {
        return {
          ok: false,
          error:
            `Attack machine is not ready yet (port ${port} is not open). ` +
            'The container may still be pulling its image or starting the VNC server — ' +
            'wait a few seconds and try again.'
        }
      }

      // noVNC v1.5.0 (otforge-attack-base): load vnc.html with autoconnect + scale.
      // /vnc.html is the standard noVNC entry point; index.html is a symlink to it.
      // ?autoconnect=true makes noVNC connect immediately without user interaction.
      // ?resize=scale scales the 1920×1080 Kali desktop to fill the BrowserWindow.
      const vncUrl = `http://localhost:${port}/vnc.html?autoconnect=true&resize=scale`

      // Dedicated non-persistent session for attack windows.
      //
      // Using fromPartition keeps this session isolated from the main renderer so
      // the clipboard-read permission grant below does not affect the main window's
      // security policy. The 'attack-novnc' partition is shared across all attack
      // windows (all connect to localhost and need identical permissions).
      const attackSession = session.fromPartition('attack-novnc')

      // Grant clipboard-read so noVNC can bridge the host clipboard into the VNC session.
      //
      // noVNC calls navigator.clipboard.readText() when the user presses Ctrl+V inside
      // the Kali Xfce4 desktop. Electron blocks this by default for non-HTTPS origins;
      // granting it here allows the paste to reach the VNC server via the RFB protocol.
      // clipboard-sanitized-write covers the reverse direction (VNC → host clipboard).
      attackSession.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
      })
      attackSession.setPermissionCheckHandler((_wc, permission) => {
        return permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'
      })

      const attackWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: `Attack Machine — ${nodeId}`,
        autoHideMenuBar: true,
        // Dark red background flash-prevention (Kali's default terminal colors)
        backgroundColor: '#1a0000',
        webPreferences: {
          session: attackSession,
          // Full sandbox — the noVNC page needs no Electron APIs
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          // webviewTag off — the noVNC page renders directly in the window
          webviewTag: false
        }
      })

      attackWindow.loadURL(vncUrl)

      // Prevent the noVNC page from opening any additional windows
      attackWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

      // Track this window so attack:pasteClipboard can reach it later.
      // Replace any stale reference for the same nodeId (user re-opened).
      attackWindows.set(nodeId, attackWindow)
      attackWindow.on('closed', () => {
        // Only delete if this specific instance is still the tracked one,
        // preventing a race where a newer window was opened before this closed.
        if (attackWindows.get(nodeId) === attackWindow) {
          attackWindows.delete(nodeId)
        }
      })

      return { ok: true }
    }
  )

  /**
   * Pushes the host clipboard text into the open noVNC desktop session.
   *
   * How it works:
   *   1. Reads the host clipboard via Electron's native clipboard module.
   *   2. Finds the open noVNC BrowserWindow for the given attack machine.
   *   3. Injects JavaScript that sets the value of noVNC's built-in
   *      #noVNC_clipboard_text textarea and dispatches a 'change' event.
   *   4. noVNC v1.5.0 handles 'change' by calling rfb.clipboardPasteFrom(text),
   *      which sends a ClientCutText message via the RFB protocol.
   *   5. TigerVNC makes the text available as the guest X11 CLIPBOARD selection.
   *   6. The user pastes in the Kali terminal with Ctrl+Shift+V (or Ctrl+V in
   *      GUI apps like a text editor).
   *
   * Returns { ok: false, error } if the window is not open, the clipboard is
   * empty, or the noVNC clipboard element is not yet present in the DOM.
   */
  ipcMain.handle('attack:pasteClipboard', async (_event, { nodeId }: { nodeId: string }) => {
    const win = attackWindows.get(nodeId)
    if (!win || win.isDestroyed()) {
      return { ok: false, error: 'Kali desktop window is not open — launch it first.' }
    }
    const text = clipboard.readText()
    if (!text) {
      return { ok: false, error: 'Clipboard is empty — copy something first.' }
    }
    // JSON.stringify produces a properly escaped JS string literal so special
    // characters (quotes, newlines, unicode) in the clipboard text are safe.
    const safeText = JSON.stringify(text)
    try {
      const found = await win.webContents.executeJavaScript(
        `(function(){
          const ta = document.getElementById('noVNC_clipboard_text');
          if (!ta) return false;
          ta.value = ${safeText};
          ta.dispatchEvent(new Event('change'));
          return true;
        })()`
      )
      if (!found) {
        return {
          ok: false,
          error: 'noVNC clipboard element not found — wait for the desktop to fully load.'
        }
      }
      return { ok: true }
    } catch {
      return { ok: false, error: 'Could not reach the Kali desktop window.' }
    }
  })

  /**
   * Pastes host clipboard text directly into the focused X11 window inside the
   * Kali container using xclip (sets CLIPBOARD selection) + xdotool (fires
   * Ctrl+Shift+V into the focused window — standard paste in xfce4-terminal).
   *
   * Why this approach instead of noVNC RFB clipboard injection:
   *   The RFB ClientCutText path (attack:pasteClipboard) sets the X11 clipboard but
   *   still requires the user to manually press Ctrl+Shift+V. This handler does both
   *   steps — set and paste — in a single docker exec call, giving the user a true
   *   one-click copy-from-tutorial → appears-in-Kali-terminal experience.
   *
   * How it works:
   *   1. The host base64-encodes the clipboard text (safe for any character set).
   *   2. docker exec runs: printf BASE64 | base64 -d | xclip -sel clip
   *      This sets the X11 CLIPBOARD selection inside the container.
   *   3. 50ms later (clipboard write is async): xdotool key ctrl+shift+v
   *      This fires the paste shortcut into whatever X11 window currently has focus
   *      — the user should have an xfce4-terminal focused in the noVNC session.
   *
   * Requires: xdotool and xclip installed in the attack-base container (Layer 2).
   * DISPLAY=:1 is set in the container ENV so docker exec inherits it automatically.
   *
   * @param nodeId - Canvas node ID of the attack-machine device.
   * @param text   - Plaintext to paste (the caller reads the host clipboard).
   */
  ipcMain.handle(
    'attack:pasteToDisplay',
    async (
      _e,
      { nodeId, text }: { nodeId: string; text: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!text) return { ok: true }

      const sanitized = nodeId.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      const containerName = `${activeProjectName}-${sanitized}`

      // base64-encode so any chars (quotes, newlines, unicode) pass safely through
      // the shell argument. Base64 output is [A-Za-z0-9+/=] — safe inside single quotes.
      const encoded = Buffer.from(text).toString('base64')

      return new Promise(resolve => {
        const proc = spawn(
          'docker',
          [
            'exec',
            '-e',
            'DISPLAY=:1',
            containerName,
            'bash',
            '-c',
            // Decode base64 → pipe to xclip (sets X11 CLIPBOARD) → xdotool pastes
            `printf '%s' '${encoded}' | base64 -d | xclip -selection clipboard -i && sleep 0.05 && xdotool key --clearmodifiers ctrl+shift+v`
          ],
          { env: buildDockerEnv() }
        )

        let stderr = ''
        proc.stderr?.on('data', d => {
          stderr += d.toString()
        })
        proc.on('close', code => {
          if (code === 0) resolve({ ok: true })
          else resolve({ ok: false, error: stderr.trim() || `xdotool exit code ${code}` })
        })
        proc.on('error', err => resolve({ ok: false, error: err.message }))
      })
    }
  )

  /**
   * Combined "open window + paste clipboard" handler.
   *
   * Called by the ⚔ Attack Machine toolbar button so the user never has to
   * navigate through the AttackTerminalModal tabs.  One click:
   *   1. Opens the noVNC BrowserWindow (or re-focuses it if already open).
   *   2. Waits for the page to finish loading.
   *   3. Polls the DOM until noVNC's #noVNC_clipboard_text element appears
   *      (noVNC initialises its UI asynchronously after DOMContentLoaded).
   *   4. Injects the host clipboard text via the same DOM injection used by
   *      attack:pasteClipboard — textarea value + 'change' event → RFB
   *      ClientCutText → TigerVNC X11 CLIPBOARD selection.
   *   5. The user can then right-click → Paste (or Ctrl+Shift+V) anywhere
   *      inside the Kali session.
   *
   * If the clipboard is empty the window still opens; paste is skipped silently
   * so the user can navigate to Kali first and copy something there.
   */
  ipcMain.handle(
    'attack:launchAndPaste',
    async (_e, { nodeId }: { nodeId: string }): Promise<{ ok: boolean; error?: string }> => {
      // ── Step 1: Get or create the noVNC BrowserWindow ──────────────────────

      let win = attackWindows.get(nodeId)

      if (!win || win.isDestroyed()) {
        // No open window — run the same setup as attack:launchWindow.
        const port = activeAttackPorts.get(nodeId)
        if (!port) {
          return {
            ok: false,
            error: 'No noVNC port found for this attack machine — is the simulation running?'
          }
        }
        const ready = await isPortOpen(port)
        if (!ready) {
          return {
            ok: false,
            error:
              `Attack machine is not ready yet (port ${port} is not open). ` +
              'Wait a few seconds and try again.'
          }
        }

        const vncUrl = `http://localhost:${port}/vnc.html?autoconnect=true&resize=scale`
        const attackSession = session.fromPartition('attack-novnc')
        attackSession.setPermissionRequestHandler((_wc, permission, callback) => {
          callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
        })
        attackSession.setPermissionCheckHandler((_wc, permission) => {
          return permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'
        })

        const attackWindow = new BrowserWindow({
          width: 1280,
          height: 900,
          minWidth: 800,
          minHeight: 600,
          title: `Attack Machine — ${nodeId}`,
          autoHideMenuBar: true,
          backgroundColor: '#1a0000',
          webPreferences: {
            session: attackSession,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false
          }
        })

        attackWindow.loadURL(vncUrl)
        attackWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        attackWindows.set(nodeId, attackWindow)
        attackWindow.on('closed', () => {
          if (attackWindows.get(nodeId) === attackWindow) attackWindows.delete(nodeId)
        })

        // Wait for the page HTML to finish loading before attempting DOM access.
        await new Promise<void>(resolve => {
          if (attackWindow.webContents.isLoading()) {
            attackWindow.webContents.once('did-finish-load', () => resolve())
          } else {
            resolve()
          }
        })

        win = attackWindow
      } else {
        // Window already open — bring it to the front.
        if (win.isMinimized()) win.restore()
        win.focus()
      }

      // ── Step 2: Inject host clipboard into noVNC ────────────────────────────

      const text = clipboard.readText()
      if (!text) {
        // No clipboard content; window is open, paste skipped silently.
        return { ok: true }
      }

      const safeText = JSON.stringify(text)

      // noVNC initialises its UI asynchronously after DOMContentLoaded, so
      // #noVNC_clipboard_text may not yet exist when did-finish-load fires.
      // Poll every 200 ms for up to 5 seconds to handle slow connections.
      try {
        const found = await win.webContents.executeJavaScript(`
          new Promise(function(resolve) {
            var deadline = Date.now() + 5000;
            function check() {
              var ta = document.getElementById('noVNC_clipboard_text');
              if (ta) {
                ta.value = ${safeText};
                ta.dispatchEvent(new Event('change'));
                resolve(true);
              } else if (Date.now() < deadline) {
                setTimeout(check, 200);
              } else {
                resolve(false);
              }
            }
            check();
          })
        `)
        if (!found) {
          return {
            ok: false,
            error:
              'noVNC clipboard element not found — wait for the desktop to fully load and try again.'
          }
        }
        return { ok: true }
      } catch {
        return { ok: false, error: 'Could not inject clipboard into the Kali desktop window.' }
      }
    }
  )

  // ── Standalone xterm.js terminal window ─────────────────────────────────────

  /**
   * Opens (or focuses) a dedicated Electron BrowserWindow containing a full
   * xterm.js terminal wired to the attack machine's docker exec PTY session.
   *
   * This is the primary interface for the ⚔ Attack Machine toolbar button:
   *   1. Creates a native OS window loading terminal.html with the nodeId as a
   *      URL query parameter (?nodeId=attack-1).
   *   2. The terminal page calls terminal:open to start the docker exec session.
   *
   * Window re-use: if the window is already open for this session, it is brought
   * to the front. If a pasteText is provided and a PTY is already active, the
   * text is written directly without waiting for a new open sequence.
   *
   * Security:
   *   sandbox: false is required for the preload script to call contextBridge
   *   and ipcRenderer. nodeIntegration: false + contextIsolation: true ensure the
   *   renderer page (terminal.html) cannot access Node.js or Electron directly.
   *
   * @param nodeId    - Canvas node ID of the attack-machine device.
   * @param pasteText - Optional clipboard text to auto-paste after bash is ready.
   * @returns { ok: true } on success; { ok: false, error } if no simulation is running.
   */
  ipcMain.handle(
    'attack:openTerminalWindow',
    async (_e, { nodeId }: { nodeId: string }): Promise<{ ok: boolean; error?: string }> => {
      if (!activeProjectName) {
        return { ok: false, error: 'No simulation is running — start a scenario first.' }
      }

      // If the window already exists, just bring it to the front.
      if (terminalWindow && !terminalWindow.isDestroyed()) {
        if (terminalWindow.isMinimized()) terminalWindow.restore()
        terminalWindow.focus()
        return { ok: true }
      }

      // terminal.html is served by the Vite dev server in development, or loaded
      // from the compiled renderer directory in production.
      terminalWindow = new BrowserWindow({
        width: 900,
        height: 620,
        minWidth: 600,
        minHeight: 400,
        title: `Kali Terminal — ${nodeId}`,
        autoHideMenuBar: true,
        // Match xterm.js background to prevent a white flash on load
        backgroundColor: '#0d1117',
        webPreferences: {
          /**
           * terminal-window.ts preload: exposes only terminal/clipboard/on IPC.
           * Vite 8 / rolldown produces .mjs for ESM preload bundles.
           */
          preload: join(__dirname, '../preload/terminalWindow.mjs'),
          contextIsolation: true,
          nodeIntegration: false,
          // sandbox: false is required so the preload can use contextBridge +
          // ipcRenderer. The terminal page itself has no Node.js access.
          sandbox: false,
          webviewTag: false
        }
      })

      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        // Dev: Vite serves terminal.html alongside index.html on the same dev server
        terminalWindow.loadURL(
          `${process.env['ELECTRON_RENDERER_URL']}/terminal.html?nodeId=${encodeURIComponent(nodeId)}`
        )
      } else {
        // Production: load the compiled HTML file with nodeId as a query parameter
        terminalWindow.loadFile(join(__dirname, '../renderer/terminal.html'), {
          query: { nodeId }
        })
      }

      terminalWindow.on('closed', () => {
        terminalWindow = null
      })

      return { ok: true }
    }
  )

  // ── Engineering Workstation window ───────────────────────────────────────────

  /**
   * Returns the localhost URL for the noVNC web interface of the given engineering
   * workstation device. The URL points to the websockify bridge (container port 6080)
   * published on the host port tracked in activeWorkstationPorts.
   *
   * @param nodeId - Canvas node ID of the engineering-workstation device.
   * @returns { url } on success, { error } if the simulation is not running
   *   or the device is not found in the active port map.
   */
  ipcMain.handle('workstation:getVncUrl', (_e, { nodeId }: { nodeId: string }) => {
    const port = activeWorkstationPorts.get(nodeId)
    if (!port) {
      return { error: 'No noVNC port found — is the simulation running?' }
    }
    return { url: `http://localhost:${port}/vnc.html?autoconnect=true&resize=scale` }
  })

  /**
   * Opens the engineering workstation's Xfce4 Linux desktop in a separate Electron
   * BrowserWindow that loads the noVNC WebSocket interface.
   *
   * The workstation runs Ubuntu 22.04 with Wireshark, nmap, tshark, tcpdump,
   * and Python ICS protocol scripts (Modbus, OPC UA, BACnet, DNP3) pre-installed
   * on the desktop. Students use it to interact with OT devices as an operator.
   *
   * @param nodeId - Canvas node ID of the engineering-workstation device.
   * @returns { ok: true } on success, { ok: false, error } if the simulation is not
   *   running or the device's noVNC port is not yet open.
   */
  ipcMain.handle(
    'workstation:launchWindow',
    async (_e, { nodeId }: { nodeId: string }): Promise<{ ok: boolean; error?: string }> => {
      const port = activeWorkstationPorts.get(nodeId)
      if (!port) {
        return {
          ok: false,
          error: 'No noVNC port found for this workstation — is the simulation running?'
        }
      }

      // Open the noVNC window immediately — the noVNC client displays its own
      // "Connecting…" spinner while websockify starts, so we do not need to probe
      // the port first. Blocking here would cause the button to silently do nothing
      // while the Ubuntu + TigerVNC + websockify startup (30-60 s) is in progress.
      const vncUrl = `http://localhost:${port}/vnc.html?autoconnect=true&resize=scale`

      // Dedicated non-persistent session for workstation windows, isolated from the
      // main renderer and from attack windows.
      const wsSession = session.fromPartition('workstation-novnc')
      wsSession.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
      })
      wsSession.setPermissionCheckHandler((_wc, permission) => {
        return permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'
      })

      const wsWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: `Engineering Workstation — ${nodeId}`,
        autoHideMenuBar: true,
        // Dark background matches Xfce4 default terminal colours
        backgroundColor: '#2c2c2c',
        webPreferences: {
          session: wsSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false
        }
      })

      wsWindow.loadURL(vncUrl)
      wsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

      workstationWindows.set(nodeId, wsWindow)
      wsWindow.on('closed', () => {
        if (workstationWindows.get(nodeId) === wsWindow) {
          workstationWindows.delete(nodeId)
        }
      })

      return { ok: true }
    }
  )

  // ── Community scenario packs (Phase 9) ────────────────────────────────────────

  /**
   * Opens a native file picker, extracts the chosen .otfpack ZIP, validates the
   * manifest, then builds and returns an InstalledPack with icon data URLs pre-loaded.
   *
   * ZIP extraction is done with platform-native tools to avoid npm dependencies:
   *   Windows — `powershell.exe Expand-Archive`
   *   macOS / Linux — `unzip`
   *
   * Install directory: <userData>/packs/<packId>/
   * A hidden .pack-meta.json file records the installation timestamp.
   */
  ipcMain.handle('pack:install', async (): Promise<PackInstallResult> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Install Scenario Pack',
      filters: [{ name: 'ICS Scenario Pack', extensions: ['otfpack'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'Install cancelled' }
    }
    const zipPath = result.filePaths[0]

    // Extract the ZIP to a temp location first so we can read pack.json before
    // deciding the final install directory (pack id determines the folder name).
    const tmpDir = pathJoin(app.getPath('userData'), 'packs', `_tmp_${Date.now()}`)
    try {
      await mkdir(tmpDir, { recursive: true })
      await extractPackZip(zipPath, tmpDir)
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: `Failed to extract pack: ${(err as Error).message}` }
    }

    // Read and validate pack.json
    let manifest: OTForgePackManifest
    try {
      const raw = JSON.parse(await readFile(pathJoin(tmpDir, 'pack.json'), 'utf-8'))
      if (!raw.id || !raw.name || !raw.formatVersion) {
        throw new Error('pack.json is missing required fields (id, name, formatVersion)')
      }
      manifest = raw as OTForgePackManifest
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: `Invalid pack.json: ${(err as Error).message}` }
    }

    // Move temp dir to the final location: <userData>/packs/<packId>/
    // If a pack with the same id is already installed, overwrite it.
    const finalDir = pathJoin(app.getPath('userData'), 'packs', manifest.id)
    try {
      await rm(finalDir, { recursive: true, force: true })
      // fs.rename doesn't work across volumes; re-extract directly to finalDir instead
      await rm(tmpDir, { recursive: true, force: true })
      await mkdir(finalDir, { recursive: true })
      await extractPackZip(zipPath, finalDir)
    } catch (err) {
      await rm(finalDir, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: `Failed to install pack: ${(err as Error).message}` }
    }

    const installedAt = new Date().toISOString()
    // Write a metadata sidecar file so pack:list can recover installedAt without
    // re-reading every scenario file every time the pack manager opens.
    await writeFile(
      pathJoin(finalDir, '.pack-meta.json'),
      JSON.stringify({ installedAt }),
      'utf-8'
    ).catch(() => {})

    const pack = await buildInstalledPack(finalDir, manifest, installedAt)
    return { ok: true, pack }
  })

  /** Lists every pack installed in <userData>/packs/. */
  ipcMain.handle('pack:list', async (): Promise<PackListResult> => {
    const dir = pathJoin(app.getPath('userData'), 'packs')
    try {
      await mkdir(dir, { recursive: true })
      const entries = await readdir(dir, { withFileTypes: true })
      const packs: InstalledPack[] = []
      for (const entry of entries) {
        // Skip hidden/temp directories (e.g., _tmp_* extraction dirs)
        if (!entry.isDirectory() || entry.name.startsWith('_tmp_') || entry.name.startsWith('.')) {
          continue
        }
        const packPath = pathJoin(dir, entry.name)
        try {
          const manifest = JSON.parse(
            await readFile(pathJoin(packPath, 'pack.json'), 'utf-8')
          ) as OTForgePackManifest
          let installedAt = new Date().toISOString()
          try {
            const meta = JSON.parse(await readFile(pathJoin(packPath, '.pack-meta.json'), 'utf-8'))
            installedAt = meta.installedAt ?? installedAt
          } catch {
            /* sidecar absent — use current time */
          }
          packs.push(await buildInstalledPack(packPath, manifest, installedAt))
        } catch {
          /* skip packs with corrupt manifests */
        }
      }
      return { packs }
    } catch {
      return { packs: [] }
    }
  })

  /**
   * Uninstalls a pack by deleting its directory from <userData>/packs/<packId>/.
   * @param packId - The pack.id value from its manifest.
   */
  ipcMain.handle(
    'pack:uninstall',
    async (_e, { packId }: { packId: string }): Promise<PackUninstallResult> => {
      // Validate packId before constructing any path — prevents directory traversal
      // (e.g. packId = ".." would otherwise delete the entire userData/packs/ parent).
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(packId)) {
        return { ok: false, error: 'Invalid pack ID.' }
      }
      const packsRoot = pathJoin(app.getPath('userData'), 'packs')
      const packPath = pathJoin(packsRoot, packId)
      // Double-check the resolved path stays inside the packs root
      const rel = pathRelative(packsRoot, packPath)
      if (rel.startsWith('..') || rel.includes('..')) {
        return { ok: false, error: 'Invalid pack path.' }
      }
      try {
        await rm(packPath, { recursive: true, force: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /**
   * Loads a bundled scenario from an installed pack and returns it ready to open.
   *
   * @param packId       - Pack identifier (folder name under <userData>/packs/).
   * @param relativePath - Path relative to the pack root, e.g. "scenarios/attack.otflab".
   */
  ipcMain.handle(
    'pack:openScenario',
    async (
      _e,
      { packId, relativePath }: { packId: string; relativePath: string }
    ): Promise<ScenarioImportResult> => {
      // Validate packId before path construction (same rule as pack:uninstall)
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(packId)) {
        return { ok: false, error: 'Invalid pack ID.' }
      }
      const packRoot = pathJoin(app.getPath('userData'), 'packs', packId)
      const scenarioPath = pathJoin(packRoot, relativePath)
      // Ensure the resolved path stays inside the pack directory — prevents a
      // malicious relativePath like "../../sensitive.json" from escaping.
      const rel = pathRelative(packRoot, scenarioPath)
      if (rel.startsWith('..') || rel.includes('..')) {
        return { ok: false, error: 'Invalid scenario path.' }
      }
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(scenarioPath, 'utf-8'))
      } catch (err) {
        return { ok: false, error: `Failed to read scenario: ${(err as Error).message}` }
      }
      const { validateScenario: validate } = await import('@otforge/orchestrator')
      const validation = validate(raw)
      if (!validation.valid) {
        return { ok: false, error: `Invalid scenario: ${validation.errors.join('\n')}` }
      }
      const scenario = raw as OTForgeScenario
      const resourceEstimate = estimateResources(scenario)
      await saveActiveScenario(scenario)
      return { ok: true, scenario, resourceEstimate }
    }
  )

  // ── FUXA windows (HMI editor, device-specific HMI, SCADA Overview) ────────────

  /**
   * Opens a FUXA path in a standalone, sandboxed Electron BrowserWindow. Shared by
   * `hmi:open`, `hmi:openEditor`, and `scada:open` -- they're all structurally
   * identical (same guard, same webPreferences), differing only in title/path/color.
   *
   * If FUXA is not yet ready (port 1881 not open) returns an error rather than opening
   * a blank window — same guard used by attack:launchWindow.
   */
  async function openFuxaWindow(
    title: string,
    path: string,
    backgroundColor: string
  ): Promise<{ ok: boolean; error?: string }> {
    if (!activeProjectName) {
      return { ok: false, error: 'No simulation is running.' }
    }

    const ready = await isPortOpen(1881)
    if (!ready) {
      return {
        ok: false,
        error:
          'FUXA HMI is not ready yet (port 1881 is not open). ' +
          'Wait a few seconds for the container to finish starting, then try again.'
      }
    }

    const fuxaWindow = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      title,
      autoHideMenuBar: true,
      backgroundColor,
      webPreferences: {
        // Full sandbox — the FUXA page is a third-party web app with no Electron APIs
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false
      }
    })

    fuxaWindow.loadURL(`http://localhost:1881${path}`)
    // Prevent FUXA from opening pop-out windows that bypass our sandbox settings
    fuxaWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    return { ok: true }
  }

  /**
   * Opens the FUXA view linked to a specific HMI device at runtime (the view an
   * author built via `hmi:openEditor`, named deterministically from the device's
   * nodeId by `buildHmiViewName()` in configureFuxa()).
   *
   * `?viewName=` is a query param FUXA's HomeComponent reads on startup
   * (`route.snapshot.queryParamMap.get('viewName')`) to pick the start view by exact
   * name match — confirmed against FUXA's client source. FUXA uses Angular's default
   * PathLocationStrategy (no hash routing).
   *
   * @param viewName - The FUXA view name to open (computed by the renderer the same
   *   way configureFuxa() computed it when bootstrapping the placeholder).
   * @returns { ok: true } on success, { ok: false, error } if simulation is not
   *   running or FUXA's port is not yet accepting connections.
   */
  ipcMain.handle(
    'hmi:open',
    async (_event, viewName: string): Promise<{ ok: boolean; error?: string }> =>
      openFuxaWindow(
        'FUXA — Process HMI',
        `/home?viewName=${encodeURIComponent(viewName)}`,
        '#1e1e2e'
      )
  )

  /**
   * Opens FUXA's editor, unscoped — for an author to build/edit any view, including
   * an HMI device's bootstrapped placeholder (already visible by name in FUXA's own
   * Views sidebar; FUXA's editor route has no query-param-based view selector to deep
   * link into, confirmed against its client source, so manual selection there is the
   * expected flow).
   *
   * @returns { ok: true } on success, { ok: false, error } if simulation is not
   *   running or FUXA's port is not yet accepting connections.
   */
  ipcMain.handle('hmi:openEditor', async (): Promise<{ ok: boolean; error?: string }> =>
    openFuxaWindow('FUXA — Editor', '/editor', '#1e1e2e')
  )

  /**
   * Opens FUXA directly into the auto-generated "SCADA Overview" view (OT-zone
   * devices only) — students land on the P&ID diagram immediately rather than FUXA's
   * home/editor root.
   *
   * @returns { ok: true } on success, { ok: false, error } if simulation is not
   *   running or FUXA's port is not yet accepting connections.
   */
  ipcMain.handle('scada:open', async (): Promise<{ ok: boolean; error?: string }> =>
    openFuxaWindow(
      'SCADA Overview — OT Process',
      `/home?viewName=${encodeURIComponent('SCADA Overview')}`,
      '#0d1117'
    )
  )

  // ── PLC firmware import ────────────────────────────────────────────────────────

  /**
   * Opens a native file picker for PLC project files, parses the selected file,
   * and returns one or more importable Structured Text routines.
   *
   * Supported formats:
   *   .l5x     — Rockwell Logix Designer (Studio 5000) project export
   *   .xml     — PLCopen XML / CODESYS export, or L5X saved as .xml
   *   .export  — CODESYS / Beckhoff TwinCAT project export
   *   .st      — Plain IEC 61131-3 Structured Text source
   *   .scl     — Siemens Structured Control Language source
   *
   * The renderer presents a routine picker modal when multiple ST routines are
   * found (common in multi-routine L5X files). The selected routine's source and
   * variable declarations are loaded into the PLC IDE editor.
   *
   * @returns PlcImportResult — ok=true with routines array on success, ok=false with
   *   error string when the file is unsupported or cannot be parsed.
   */
  ipcMain.handle('plc:importProgram', async (): Promise<PlcImportResult> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import PLC Program',
      filters: [
        {
          name: 'PLC Project Files',
          extensions: ['l5x', 'xml', 'export', 'st', 'scl']
        }
      ],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'Import cancelled' }
    }

    const filePath = result.filePaths[0]
    try {
      const fileBuffer = await readFile(filePath)
      return parsePlcFile(filePath, fileBuffer)
    } catch (err) {
      return {
        ok: false,
        error: `Could not read file: ${(err as Error).message}`
      }
    }
  })
}

// ── Pack helpers (Phase 9) ────────────────────────────────────────────────────

/**
 * Extracts a .otfpack ZIP archive to the given destination directory.
 *
 * Uses platform-native tools to avoid adding npm dependencies to the main process:
 *   Windows — `powershell.exe Expand-Archive` (built into Windows 5.x+)
 *   macOS / Linux — `unzip` (pre-installed on both platforms)
 *
 * The destination directory must already exist before calling this function.
 *
 * @param zipPath  - Absolute path to the .otfpack ZIP file.
 * @param destPath - Absolute path to the directory to extract into.
 */
function extractPackZip(zipPath: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>
    if (process.platform === 'win32') {
      // Use -LiteralPath so paths with special chars are treated verbatim.
      // Single-quote the paths inside the PS script — PS literal strings ignore
      // wildcards/variables, so spaces and dots in userData paths are safe.
      // Single quotes within paths are doubled per PowerShell quoting rules.
      const safe = (p: string) => p.replace(/'/g, "''")
      proc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath '${safe(zipPath)}' -DestinationPath '${safe(destPath)}' -Force`
        ],
        { env: process.env }
      )
    } else {
      // -o overwrites existing files so reinstalling a pack is clean
      proc = spawn('unzip', ['-o', zipPath, '-d', destPath], { env: process.env })
    }

    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    proc.on('close', code => {
      if (code === 0 || code === null) resolve()
      else reject(new Error(`Extraction exited with code ${code}: ${stderr.trim()}`))
    })
    proc.on('error', reject)
  })
}

/**
 * Builds an InstalledPack runtime descriptor from a pack directory on disk.
 *
 * Reads the device registry (if present) and converts SVG icon files to base64
 * data URLs so the renderer can display pack icons without any file I/O.
 * Reads each bundled scenario file to extract its name and description.
 *
 * @param packPath    - Absolute path to the extracted pack directory.
 * @param manifest    - The parsed pack.json manifest.
 * @param installedAt - ISO 8601 timestamp of when the pack was installed.
 */
async function buildInstalledPack(
  packPath: string,
  manifest: OTForgePackManifest,
  installedAt: string
): Promise<InstalledPack> {
  // ── Device types ──────────────────────────────────────────────────────────────
  let deviceTypes: ResolvedPackDeviceType[] = []
  if (manifest.deviceRegistry) {
    try {
      const registryPath = pathJoin(packPath, manifest.deviceRegistry)
      const rawTypes = JSON.parse(await readFile(registryPath, 'utf-8')) as PackDeviceType[]
      deviceTypes = await Promise.all(
        rawTypes.map(async (dt: PackDeviceType): Promise<ResolvedPackDeviceType> => {
          let iconDataUrl = ''
          if (dt.iconPath) {
            // Icon paths are relative to the devices/ folder per icspack format spec
            const iconFullPath = pathJoin(packPath, 'devices', dt.iconPath)
            try {
              const svgData = await readFile(iconFullPath, 'utf-8')
              iconDataUrl = `data:image/svg+xml;base64,${Buffer.from(svgData).toString('base64')}`
            } catch {
              /* icon missing — fall back to standard category icon */
            }
          }
          return { ...dt, iconDataUrl, packId: manifest.id }
        })
      )
    } catch {
      /* deviceRegistry absent or parse failure — leave deviceTypes empty */
    }
  }

  // ── Scenario metas ────────────────────────────────────────────────────────────
  const scenarioMetas: PackScenarioMeta[] = []
  for (const relPath of manifest.scenarios) {
    // Default display values in case the file can't be parsed
    let name = (relPath.split('/').pop() ?? relPath).replace(/\.otflab$/i, '')
    let description = ''
    let locked = false
    try {
      const scenarioPath = pathJoin(packPath, relPath)
      const raw = JSON.parse(await readFile(scenarioPath, 'utf-8'))
      name = raw.meta?.name ?? name
      description = raw.meta?.description ?? ''
      locked = raw.meta?.locked ?? false
    } catch {
      /* use defaults if scenario file is missing or corrupt */
    }
    scenarioMetas.push({ relativePath: relPath, name, description, locked })
  }

  return { manifest, installPath: packPath, installedAt, deviceTypes, scenarioMetas }
}

// ── Firewall nft script generator ─────────────────────────────────────────────

/**
 * Builds a POSIX sh script that rebuilds the nftables forward chain from the
 * given ACL rules and default policy. The script is piped via stdin into the
 * running firewall container — no image change or pre-installed reload script
 * is required because the container already has `sh` and `nft`.
 *
 * All values are inlined from TypeScript data so the script contains no shell
 * variables and is safe to pipe without any escaping concerns.
 *
 * @param rules         - Current ACL rule list (deny rules applied before allow).
 * @param defaultPolicy - "drop" or "accept".
 * @param zones         - Zone name → CIDR map captured at simulation start.
 */
function buildNftScript(
  rules: ACLRule[],
  defaultPolicy: string,
  zones: Record<string, string>
): string {
  const lines: string[] = [
    'set -e',
    '# Flush only the forward chain — preserves NAT masquerade and other tables.',
    'nft flush chain inet ics_fw forward',
    `nft chain inet ics_fw forward "{ policy ${defaultPolicy}; }"`,
    '# Baseline: always allow established/related connections and ICMP.',
    'nft add rule inet ics_fw forward ct state established,related accept',
    'nft add rule inet ics_fw forward ip protocol icmp accept',
    'nft add rule inet ics_fw forward ip6 nexthdr icmpv6 accept'
  ]

  // Deny rules first so explicit denies take precedence over any allow rule.
  const ordered = [
    ...rules.filter(r => r.action === 'deny'),
    ...rules.filter(r => r.action === 'allow')
  ]

  for (const rule of ordered) {
    const parts = ['nft', 'add', 'rule', 'inet', 'ics_fw', 'forward']

    const srcSubnet = rule.sourceZone !== 'any' ? zones[rule.sourceZone] : undefined
    const dstSubnet = rule.destinationZone !== 'any' ? zones[rule.destinationZone] : undefined
    if (srcSubnet) parts.push('ip', 'saddr', srcSubnet)
    if (dstSubnet) parts.push('ip', 'daddr', dstSubnet)

    if (rule.protocol === 'tcp') {
      if (rule.destinationPort !== 'any') parts.push('tcp', 'dport', String(rule.destinationPort))
    } else if (rule.protocol === 'udp') {
      if (rule.destinationPort !== 'any') parts.push('udp', 'dport', String(rule.destinationPort))
    } else if (rule.protocol === 'icmp') {
      parts.push('ip', 'protocol', 'icmp')
    }

    parts.push(rule.action === 'allow' ? 'accept' : 'drop')
    lines.push(parts.join(' '))
  }

  // Terminal reject: unmatched traffic gets ICMP admin-prohibited (immediate response)
  // rather than a silent drop. Explicit deny rules above still use 'drop'.
  // This prevents nmap /24 scans from hanging on TCP probe timeouts.
  lines.push('nft add rule inet ics_fw forward reject with icmp type admin-prohibited')

  lines.push(
    'echo "[ics-firewall] Reload complete — $(nft list chain inet ics_fw forward | grep -c rule) rule(s) active"'
  )
  return lines.join('\n') + '\n'
}

// ── TCP port connectivity helper ──────────────────────────────────────────────

/**
 * Probes whether a TCP port on localhost is accepting connections.
 *
 * Used by the `attack:launchWindow` handler to verify the attack machine's
 * noVNC websockify server is ready before opening the BrowserWindow. Without
 * this check, the window opens to an immediate "Connection refused" or noVNC
 * "Unable to connect" error if the container is still starting up.
 *
 * @param port    - Host port to probe (e.g., 6900 for the first attack machine).
 * @param timeout - Milliseconds to wait before declaring the port closed (default 2000).
 * @returns true if the port accepted a TCP connection; false otherwise.
 */
function isPortOpen(port: number, timeout = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: 'localhost' })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeout)
    socket.on('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

// ── Attack machine post-start provisioning ────────────────────────────────────

/**
 * Pre-installs common network analysis tools in each Kali attack machine container
 * after the simulation starts. Runs as fire-and-forget from the simulation:start handler.
 *
 * Why not bake them into the image?
 *   We use the upstream `lscr.io/linuxserver/kali-linux` image directly (no custom
 *   build step). Installing at container start keeps the image pull lean while still
 *   giving students the tools they need for ICS/SCADA penetration exercises.
 *
 * Packages installed:
 *   iputils-ping      — ping / arping — basic reachability and ARP testing
 *   iproute2          — ip, ss, tc   — interface/route/socket inspection
 *   netcat-openbsd    — nc           — TCP/UDP connection tester and banner grabber
 *
 * The function waits up to 90 seconds for the container's KasmVNC port to open
 * (signals that the desktop is fully up), then runs a single `docker exec` per
 * attack machine. All errors are swallowed — if apt-get fails (e.g., no internet
 * in an air-gapped lab), the container still works; the user just needs to install
 * packages manually.
 *
 * docker exec runs as root (the container default), so no sudo is required.
 */
/**
 * Derives the student save-folder name for a scenario, e.g.
 * "ICS Lab 03 — …" → "Lab_03_Student_Saved_Work". Non-numbered scenarios
 * (OpenPLC_Lab, Learning…) fall back to a sanitized scenario name.
 * Shared by folder provisioning (create) and session save/load (docker cp),
 * so both always agree on the path.
 */
function labSaveFolderName(scenario: OTForgeScenario): string {
  const name = scenario.meta.name ?? 'Lab'
  const labMatch = name.match(/\bLab\s+0*(\d+)/i)
  if (labMatch) {
    return `Lab_${labMatch[1].padStart(2, '0')}_Student_Saved_Work`
  }
  const slug = name
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return `${slug || 'Lab'}_Student_Saved_Work`
}

/**
 * Creates the per-lab "…_Student_Saved_Work" folder on each workstation after the
 * desktop boots, with a README telling students to keep their work there. The
 * folder lives at /root/Desktop/<name> so it is one click from the Xfce desktop.
 * Save Session later captures this folder (docker cp) into the session bundle.
 *
 * Best-effort and fire-and-forget: any failure just means the student can create
 * the folder themselves; it must never block or crash a running simulation.
 */
async function configureWorkstationSaveFolder(scenario: OTForgeScenario): Promise<void> {
  if (!activeProjectName || activeWorkstationPorts.size === 0) return
  // Capture the active project name up-front — it's a mutable module var and this
  // function awaits, so pin it for the restore-flag comparison and cp paths.
  const proj = activeProjectName

  const folder = labSaveFolderName(scenario)
  // ASCII only, no shell-special characters (runs through cmd.exe on Windows).
  const readme =
    'Save any work you want to keep in this folder - PLC programs, Wireshark ' +
    'captures, notes. Everything here is preserved when you click Save Session ' +
    'in OTForge, so you can resume this lab later.'

  const MAX_WAIT_MS = 90_000
  const POLL_INTERVAL_MS = 3_000

  for (const [nodeId, vncPort] of activeWorkstationPorts) {
    // Same container-name derivation as compose-generator.ts / configureAttackMachine.
    const sanitized = nodeId.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const containerName = `${proj}-${sanitized}`

    // Wait for the workstation's noVNC port so the desktop is up before we touch it.
    const deadline = Date.now() + MAX_WAIT_MS
    while (Date.now() < deadline) {
      if (await isPortOpen(vncPort, 1500)) break
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }

    try {
      await execAsync(
        `docker exec ${containerName} bash -c ` +
          `"mkdir -p /root/Desktop/${folder} && echo '${readme}' > /root/Desktop/${folder}/README.txt"`,
        { timeout: 30_000 }
      )
    } catch {
      // Non-fatal — the student can still create the folder manually.
    }

    // If the student chose Load Session for this project, copy their saved work
    // back into the freshly-created folder (contents merge over the README).
    if (pendingSessionRestore === proj) {
      const src = pathJoin(sessionDir(app.getPath('userData'), proj), 'lab-work')
      try {
        await access(src) // throws if the session has no captured work
        await execAsync(`docker cp "${src}/." ${containerName}:/root/Desktop/${folder}`, {
          timeout: 60_000
        })
      } catch {
        // No saved lab-work, or cp failed — folder stays as freshly created.
      }
    }
  }

  // Consume the one-shot restore flag so a later fresh run doesn't re-restore.
  if (pendingSessionRestore === proj) pendingSessionRestore = null
}

/**
 * Captures the student's Lab_NN_Student_Saved_Work folder out of the running
 * workstation into the session bundle (<userData>/sessions/<project>/lab-work),
 * via `docker cp`. Best-effort: if the workstation isn't running or the folder
 * doesn't exist, the session is still saved with the scenario + step.
 */
async function captureLabFolder(scenario: OTForgeScenario, projectName: string): Promise<void> {
  const wsNode = Object.entries(scenario.devices.devices).find(
    ([, d]) => d.category === 'engineering-workstation'
  )?.[0]
  if (!wsNode) return // scenario has no workstation to capture from

  const sanitized = wsNode.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const containerName = `${projectName}-${sanitized}`
  const folder = labSaveFolderName(scenario)
  const dest = pathJoin(sessionDir(app.getPath('userData'), projectName), 'lab-work')

  try {
    // Remove any prior capture so the copy reflects the current folder exactly.
    await rm(dest, { recursive: true, force: true })
    await execAsync(`docker cp ${containerName}:/root/Desktop/${folder} "${dest}"`, {
      timeout: 60_000
    })
  } catch {
    // Workstation not running or folder absent — scenario + step were still saved.
  }
}

async function configureAttackMachine(): Promise<void> {
  if (!activeProjectName || activeAttackPorts.size === 0) return

  const MAX_WAIT_MS = 90_000
  const POLL_INTERVAL_MS = 3_000

  for (const [nodeId, vncPort] of activeAttackPorts) {
    // Derive container name using the same logic as compose-generator.ts
    const sanitized = nodeId.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const containerName = `${activeProjectName}-${sanitized}`

    // Wait for the KasmVNC websockify port to accept connections.
    // This is the last service to start inside the container — once it's up,
    // the OS is fully booted and apt-get is safe to run.
    const deadline = Date.now() + MAX_WAIT_MS
    while (Date.now() < deadline) {
      const ready = await isPortOpen(vncPort, 1500)
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }

    // Extra grace period — apt databases need a moment after desktop init
    await new Promise(resolve => setTimeout(resolve, 3000))

    try {
      // Single exec installs all tools; `|| true` ensures non-zero apt exit codes
      // (e.g., package already installed) do not fail the shell command.
      await execAsync(
        `docker exec ${containerName} bash -c ` +
          `"apt-get update -qq 2>/dev/null && ` +
          `apt-get install -y --no-install-recommends ` +
          `iputils-ping iproute2 netcat-openbsd 2>/dev/null || true"`,
        { timeout: 90_000 }
      )
    } catch {
      // Silently ignore — apt may fail in air-gapped environments or if the
      // container exited between the port-open check and the exec call.
    }
  }
}

// ── FUXA auto-provisioning ────────────────────────────────────────────────────

/**
 * Auto-provisions ICS device connections in FUXA after a simulation starts.
 *
 * FUXA stores device connections in a SQLite database inside its named volume.
 * On every fresh simulation the volume is empty, so this function provisions
 * all three protocol families automatically — students open the HMI and see
 * live data without any manual FUXA configuration.
 *
 * Protocols provisioned:
 *   MODBUSTCP  — RTU/iec104-rtu/smart-sensor/smart-controller devices unconditionally
 *                (being a Modbus point is their whole purpose); PLC/safety-plc only
 *                when connected via a modbus-tcp canvas edge.
 *   OPCUA      — All scada-server devices (asyncua Python server, port 4840).
 *   BACnet     — All sensor devices (bacpypes3 Python server, port 47808).
 *
 * smart-sensor note: FUXA cannot act as a Modbus server (verified against FUXA's real
 * source — all its device drivers are clients), so smart-sensor's waveform is generated
 * by a real container (containers/modbus/server.py) and FUXA just polls it like any
 * other Modbus device. This function only wires up the connection + one tag for the
 * configured register; it does not generate any HMI screen/widget (out of scope).
 *
 * FUXA REST API — POST /api/device (confirmed from server/apimanager.js):
 *   {
 *     id:       string,   // Unique ID (we use the canvas node ID)
 *     name:     string,   // Display name shown in the FUXA editor
 *     enabled:  true,
 *     type:     "MODBUSTCP" | "OPCUA" | "BACnet",
 *     polling:  number,   // Poll interval in ms
 *     request:  number,   // Request timeout in ms
 *     property: object,   // Protocol-specific connection parameters (see below)
 *     tags:     {}
 *   }
 *
 *   Modbus property:  { address: "ip", port: 502, uid: 1 }
 *   OPC UA property:  { address: "opc.tcp://ip:4840" }
 *   BACnet property:  { address: "ip", port: 47808 }
 *
 * HTTP 200 = created; 400 = duplicate device id (volume persisted from a
 * previous run with the same project name) — both are acceptable; log + continue.
 *
 * Fire-and-forget from simulation:start — errors are swallowed so a slow FUXA
 * start or a scenario with no provisionable devices never blocks the caller.
 *
 * @param scenario - The scenario that was just started.
 */
async function configureFuxa(scenario: OTForgeScenario): Promise<void> {
  const FUXA_PORT = 1881

  // ── Collect Modbus/PLC nodes ──────────────────────────────────────────────
  // RTUs/smart-sensor/smart-controller are unconditionally included: every
  // otforge-modbus container runs a Modbus TCP server on port 502 regardless of
  // what canvas edges are drawn, and the RTU panel lets authors configure
  // real-world comm types (cellular, radio, etc.) that don't map to canvas wire
  // connections. smart-sensor/smart-controller are the same shape — being a
  // Modbus point is their whole purpose, not something conditional on an edge.
  // PLCs/safety-PLCs are only included when they appear on a modbus-tcp edge
  // (matching the original behaviour — PLC Modbus is the programmer's concern,
  // not a passive telemetry device like an RTU).
  const modbusNodeIds = new Set<string>()

  // All RTU/smart-sensor/smart-controller devices — no edge requirement
  for (const [nodeId, device] of Object.entries(scenario.devices.devices)) {
    if (
      device.category === 'rtu' ||
      device.category === 'iec104-rtu' ||
      device.category === 'smart-sensor' ||
      device.category === 'smart-controller'
    ) {
      modbusNodeIds.add(nodeId)
    }
  }

  // PLCs/safety-PLCs that appear on a modbus-tcp edge
  for (const edge of scenario.visual.edges) {
    if (edge.data.protocol !== 'modbus-tcp') continue
    for (const candidateId of [edge.source, edge.target]) {
      const device = scenario.devices.devices[candidateId]
      if (device && (device.category === 'plc' || device.category === 'safety-plc')) {
        modbusNodeIds.add(candidateId)
      }
    }
  }

  // ── Collect OPC UA devices (all scada-server nodes) ────────────────────────
  const opcuaEntries = Object.entries(scenario.devices.devices).filter(
    ([, d]) => d.category === 'scada-server'
  )

  // ── Collect BACnet devices (all sensor nodes) ──────────────────────────────
  const bacnetEntries = Object.entries(scenario.devices.devices).filter(
    ([, d]) => d.category === 'sensor'
  )

  // ── Collect HMI devices (Control Center zone, not OT) ──────────────────────
  // Each gets an author-built FUXA view bootstrapped below, linked by a name derived
  // from its stable nodeId (not its editable label) -- see buildHmiViewName().
  const hmiEntries = Object.entries(scenario.devices.devices).filter(
    ([, d]) => d.category === 'hmi'
  )

  const totalDevices =
    modbusNodeIds.size + opcuaEntries.length + bacnetEntries.length + hmiEntries.length
  if (totalDevices === 0) return

  // ── Wait for FUXA HTTP API (up to 60 s) ────────────────────────────────────
  // The FUXA Node.js server takes 10–20 s after container start to initialize.
  const MAX_WAIT_MS = 60_000
  const POLL_INTERVAL_MS = 3_000
  const deadline = Date.now() + MAX_WAIT_MS

  while (Date.now() < deadline) {
    const ready = await isPortOpen(FUXA_PORT, 1500)
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  // Extra 2-second grace period after the TCP port opens.
  // FUXA's Express router finishes registering ~1 s after the socket accepts.
  await new Promise(resolve => setTimeout(resolve, 2000))

  /**
   * POST a single value to FUXA's /api/projectData endpoint under the given command.
   * This is the one real contract FUXA exposes for writing devices/views/alarms into
   * its running project (verified against frangoteam/fuxa's actual server routes —
   * `/api/device` and `/api/view` are NOT creation endpoints, see callers below).
   * Best-effort: errors are swallowed so one failure doesn't block the rest of
   * provisioning, and a format mismatch between FUXA versions degrades gracefully.
   */
  async function postProjectData(cmd: string, data: unknown): Promise<void> {
    const payload = JSON.stringify({ cmd, data })
    try {
      await httpPost(
        {
          host: 'localhost',
          port: FUXA_PORT,
          path: '/api/projectData',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
        payload
      )
    } catch {
      // Connection refused or timeout — FUXA may have failed to start.
      // Log and continue so a single failure doesn't block remaining devices.
    }
  }

  /**
   * Create/update a device in FUXA's project via cmd: 'set-device'.
   * NOTE: `POST /api/device` (the endpoint this used to target) is not a device-
   * creation endpoint in FUXA — it only sets a device's `security` sub-property and
   * rejects everything else. Confirmed by curling a standalone instance of the
   * exact vendored image (ghcr.io/iburres/fuxa) — the old path returned 400 and
   * persisted nothing.
   */
  async function postDevice(device: unknown): Promise<void> {
    await postProjectData('set-device', device)
  }

  /**
   * Create/update a view in FUXA's project via cmd: 'set-view'.
   * NOTE: `POST /api/view` (the endpoint this used to target) does not exist as a
   * route in FUXA's server at all — every prior call has been silently swallowed.
   */
  async function postView(view: unknown): Promise<void> {
    await postProjectData('set-view', view)
  }

  /**
   * Create/update an alarm definition in FUXA's project via cmd: 'set-alarm'.
   * Alarms apply live (FUXA's runtime resets its alarm manager on this command) —
   * no FUXA restart needed. Confirmed via a live container before relying on it.
   */
  async function postAlarm(alarm: unknown): Promise<void> {
    await postProjectData('set-alarm', alarm)
  }

  /**
   * Sets FUXA's HMI layout via cmd: 'layout'. NOTE: this is a full replace server-side
   * (`data.hmi.layout = layout`), not a merge — only call this with a complete layout
   * object, never a partial patch, or other layout settings get silently wiped.
   */
  async function postLayout(layout: unknown): Promise<void> {
    await postProjectData('layout', layout)
  }

  /**
   * Reads the names of views that already exist in FUXA's project. Used only to decide
   * whether to bootstrap a placeholder HMI view — unlike the SCADA/RTU overview views
   * (always overwritten by id every run), an HMI device's view holds an author's
   * hand-built content once they start editing it, so it must never be silently
   * regenerated. Best-effort: an empty set on failure just means we might re-attempt
   * the bootstrap next run, which is harmless (postView no-ops on an existing id match
   * via FUXA's own setView()).
   */
  async function getExistingViewNames(): Promise<Set<string>> {
    try {
      const body = await httpGet(`http://localhost:${FUXA_PORT}/api/project`)
      const project = JSON.parse(body) as { hmi?: { views?: Array<{ name?: string }> } }
      return new Set((project.hmi?.views ?? []).map(v => v.name).filter((n): n is string => !!n))
    } catch {
      return new Set()
    }
  }

  // ── Provision Modbus TCP (PLCs / RTUs / smart-sensor / smart-controller) ───
  for (const nodeId of modbusNodeIds) {
    const device = scenario.devices.devices[nodeId]
    if (!device) continue
    const address = device.ipAddress.split('/')[0]
    const uid = device.modbus?.unitId ?? 1
    const port = device.modbus?.port ?? 502
    const isRtu = device.category === 'rtu' || device.category === 'iec104-rtu'
    const isSmartSensor = device.category === 'smart-sensor'
    const isSmartController = device.category === 'smart-controller'
    // RTUs get a full register map, smart-sensor gets its one configured register, and
    // smart-controller gets its CO0/DI0/HR0/HR1 set — all so students see live telemetry
    // without any manual FUXA tag configuration. PLCs keep an empty tag set; PLC
    // programs are the programmer's concern, not something to auto-introspect.
    const tags = isSmartSensor
      ? buildSensorModbusTag(nodeId, device)
      : isRtu
        ? buildRtuModbusTags(nodeId)
        : isSmartController
          ? buildControllerModbusTags(nodeId, device)
          : {}
    const displayName = device.label ?? nodeId
    // RTU/smart-sensor/smart-controller are Modbus end-to-end, so the clean
    // display name applies to all three; PLC/safety-plc only speak Modbus
    // incidentally, so they keep the "(Modbus)" suffix for clarity in FUXA's list.
    const isModbusNative = isRtu || isSmartSensor || isSmartController

    await postDevice({
      id: nodeId,
      name: isModbusNative ? `${displayName}` : `${displayName} (Modbus)`,
      enabled: true,
      // FUXA's DeviceEnum uses exact-case 'ModbusTCP' (server/runtime/devices/device.js)
      // -- the all-caps 'MODBUSTCP' silently fails plugin lookup and the device never
      // connects. Confirmed against a live container before fixing.
      type: 'ModbusTCP',
      polling: 1000,
      request: 30_000,
      property: { address, port, uid },
      tags
    })
  }

  // ── Provision OPC UA (SCADA servers) ──────────────────────────────────────
  // FUXA connects to an OPC UA server via its endpoint URL (opc.tcp://host:port).
  // Security is intentionally disabled for the training environment so no
  // certificate exchange is needed before tags can be browsed and logged.
  for (const [nodeId, device] of opcuaEntries) {
    const address = device.ipAddress.split('/')[0]
    const port = device.opcua?.port ?? 4840
    const endpointUrl = `opc.tcp://${address}:${port}`

    await postDevice({
      id: nodeId,
      name: `${nodeId} (OPC UA)`,
      enabled: true,
      type: 'OPCUA',
      polling: 2000,
      request: 30_000,
      // FUXA OPC UA plugin reads 'address' as the full endpoint URL.
      // Security/policy/mode left at None — matches the server container defaults.
      property: {
        address: endpointUrl,
        security: 'None',
        policy: 'None',
        mode: 'Anonymous'
      },
      tags: {}
    })
  }

  // ── Provision BACnet/IP (sensors) ─────────────────────────────────────────
  // FUXA's BACnet plugin sends Who-Is broadcasts and unicast ReadProperty to
  // discover and poll objects. We register the sensor's static IP and UDP port
  // so FUXA knows where to address its BACnet messages.
  for (const [nodeId, device] of bacnetEntries) {
    const address = device.ipAddress.split('/')[0]
    const port = device.bacnet?.port ?? 47808

    await postDevice({
      id: nodeId,
      name: `${nodeId} (BACnet)`,
      enabled: true,
      type: 'BACnet',
      polling: 2000,
      request: 30_000,
      property: { address, port },
      tags: {}
    })
  }

  // ── Create RTU Overview HMI view ───────────────────────────────────────────
  // Generates a pre-built FUXA view that shows one card per RTU: device name,
  // IP address, and the telemetry comm type from the RTU panel. Students open
  // FUXA (port 1881) from the HMI node or engineering workstation and see this
  // view immediately without any manual FUXA configuration.
  // The view is created after all devices are provisioned so FUXA's device list
  // is fully populated before the view references device IDs.
  const rtuEntries = Object.entries(scenario.devices.devices).filter(
    ([, d]) => d.category === 'rtu' || d.category === 'iec104-rtu'
  )
  if (rtuEntries.length > 0) {
    await postView(buildRtuOverviewView(rtuEntries))
  }

  // ── Create SCADA Overview HMI view (OT-zone only) ──────────────────────────
  // Auto-generated P&ID-style view scoped to OT-zone devices only, mirroring the
  // canvas's own layout -- opened via the dedicated `scada:open` window, separate
  // from the general-purpose FUXA editor/RTU overview above.
  const otTopology = getOtZoneTopology(scenario)
  if (otTopology.nodes.length > 0) {
    await postView(buildScadaOverviewView(otTopology))
    const scadaAlarms = buildScadaAlarms(otTopology.nodes)
    for (const alarm of scadaAlarms) {
      await postAlarm(alarm)
    }
    if (scadaAlarms.length > 0) {
      // FUXA's alarm bell is hidden by default: home.component.ts initializes
      // alarms.mode to '' (empty string), and checkHeaderButton() compares it against
      // the bare key names 'fix'/'float' (derived from NotificationModeType via an
      // indexOf round-trip, NOT the enum's own long 'item.notifymode-*' values) -- so
      // without this, alarms fire correctly server-side but are invisible in the UI.
      // 'float' shows the bell only while count > 0, matching real SCADA HMI
      // conventions.
      //
      // IMPORTANT: setHmiLayout() replaces the whole layout server-side (not a merge).
      // A first attempt posted only `{ header: { alarms: 'float' } }` -- this crashed
      // the runtime view entirely ("Cannot read properties of undefined (reading
      // 'mode')") because other code (the sidenav) unconditionally reads
      // layout.navigation.mode, which only exists if `navigation` is a real object.
      // Under normal use FUXA's own UI always saves a complete LayoutSettings object
      // (client/src/app/_models/hmi.ts); this must match that shape, not a sparse
      // patch, even though we only intend to change one field. Values below mirror
      // `new LayoutSettings()`'s own field defaults exactly, including the bare-key
      // (not long enum value) convention for navigation.mode/type -- confirmed against
      // NavigationSettings' constructor, which derives them the same indexOf-roundtrip
      // way as alarms/infos.
      await postLayout({
        autoresize: false,
        start: '',
        navigation: {
          mode: 'over',
          type: 'block',
          bkcolor: '#F4F5F7',
          fgcolor: '#1D1D1D',
          logo: false
        },
        header: {
          alarms: 'float',
          bkcolor: '#ffffff',
          fgcolor: '#000000',
          height: 46,
          buttonHeight: 36,
          fontSize: 13,
          itemsAnchor: 'left'
        },
        showdev: true,
        inputdialog: 'false',
        hidenavigation: false,
        theme: '',
        loginonstart: false,
        loginoverlaycolor: 'none',
        show_connection_error: true,
        customStyles: ''
      })
    }
  }

  // ── Bootstrap a placeholder HMI view per HMI device (Control Center) ──────
  // Author-built content, never overwritten once it exists -- see
  // getExistingViewNames()'s doc comment for why this can't follow the SCADA/RTU
  // overview views' always-overwrite-by-id pattern.
  if (hmiEntries.length > 0) {
    const existingViewNames = await getExistingViewNames()
    for (const [nodeId, device] of hmiEntries) {
      const viewName = buildHmiViewName(nodeId)
      if (existingViewNames.has(viewName)) continue
      await postView(buildHmiPlaceholderView(viewName, device.label ?? nodeId))
    }
  }
}

// ── FUXA HMI device view ────────────────────────────────────────────────────────

/**
 * Deterministic FUXA view id/name for an `hmi` device's author-built program.
 * Derived from the stable nodeId, not the editable device label, so renaming the
 * device on the canvas never orphans the link to its FUXA view. id and name are kept
 * identical (FUXA's setView() matches by id for overwrite, by name for the duplicate
 * check, and the runtime `?viewName=` lookup matches by name -- using the same value
 * for both sidesteps any drift between the two).
 */
function buildHmiViewName(nodeId: string): string {
  return `otf-hmi-${nodeId.replace(/[^a-z0-9]/gi, '-')}`
}

/**
 * Minimal placeholder view for a newly-detected HMI device -- just enough that opening
 * it for the first time (via the Properties Panel's "Open HMI Editor" button) shows a
 * clear starting point instead of a blank void. The author builds the real content
 * from here using FUXA's own editor; this function is never called again for a device
 * once its view already exists (see the existingViewNames check at the call site).
 */
function buildHmiPlaceholderView(viewName: string, label: string): unknown {
  return {
    id: viewName,
    name: viewName,
    profile: { width: 1280, height: 800, bkcolor: '#0d1117ff' },
    type: 'svg',
    svgcontent:
      `<svg width="1280" height="800" xmlns="http://www.w3.org/2000/svg"><g>` +
      `<text x="640" y="380" font-size="20" fill="#8b949e" text-anchor="middle">Author your HMI for "${label}" here</text>` +
      `<text x="640" y="410" font-size="14" fill="#6e7681" text-anchor="middle">Use the Controls/Shape/Widgets palette on the left, then Save</text>` +
      `</g></svg>`,
    items: {},
    variables: {}
  }
}

// ── FUXA Modbus tag addressing ─────────────────────────────────────────────────

/**
 * FUXA's Modbus driver (server/runtime/devices/modbus/index.js) selects the table
 * purely from the numeric range of a tag's `memaddress` (Modicon convention) -- the
 * `address` field (1-based) is the offset within that table. There is no `memtype`
 * field; FUXA never reads one, confirmed by reading getMemoryAddress()'s dispatch.
 * Verified end-to-end against a live container before relying on this.
 */
const MODBUS_TABLE = {
  coil: 0,
  discreteInput: 100_000,
  inputRegister: 300_000,
  holdingRegister: 400_000
} as const

// ── FUXA smart-sensor provisioning helper ─────────────────────────────────────

/**
 * Builds a single FUXA tag for a smart-sensor device's configured holding register.
 *
 * Unlike RTUs (buildRtuModbusTags below), smart-sensor has exactly one register —
 * the one containers/modbus/server.py's waveform task writes to (SensorConfig.modbusRegister)
 * — so there is exactly one tag to declare. The tag name follows the same convention the
 * schema doc promises: SensorConfig.tagName if set, otherwise derived from the node ID.
 *
 * @param nodeId - Canvas node ID of the smart-sensor device.
 * @param device - The device's full config; must have .sensor set (defensive no-op if not).
 * @returns Record with a single tag, ready for the FUXA /api/device payload.
 */
function buildSensorModbusTag(nodeId: string, device: DeviceConfig): Record<string, unknown> {
  const sensor = device.sensor
  if (!sensor) return {}
  const ns = nodeId.replace(/[^a-z0-9]/gi, '-')
  const id = `${ns}-value`
  const name = sensor.tagName ?? nodeId.replace(/[^a-zA-Z0-9]/g, '_')
  return {
    [id]: {
      id,
      name,
      type: 'Int16',
      address: sensor.modbusRegister + 1,
      memaddress: MODBUS_TABLE.holdingRegister
    }
  }
}

// ── FUXA RTU provisioning helpers ─────────────────────────────────────────────

/**
 * Builds a standard Modbus register map for an RTU device in FUXA tag format.
 *
 * Real RTUs expose four Modbus table types. This set gives students immediately
 * live-readable data without any manual FUXA tag configuration:
 *
 *   DI_0–DI_3   Discrete Inputs (FC 02, read-only bool) — sensor status, breaker states
 *   DO_0–DO_3   Coils (FC 01/05/15, read/write bool) — control outputs, relay commands
 *   IR_0–IR_3   Input Registers (FC 04, read-only int) — measurements (temp, flow, voltage)
 *   HR_0–HR_3   Holding Registers (FC 03/06/16, read/write int) — setpoints, thresholds
 *
 * Tag IDs are namespaced by nodeId so they remain unique across a multi-RTU scenario.
 *
 * @param nodeId - Canvas node ID of the RTU device (used to namespace tag IDs).
 * @returns Record of tag objects keyed by tag ID, ready for the FUXA /api/device payload.
 */
function buildRtuModbusTags(nodeId: string): Record<string, unknown> {
  const tags: Record<string, unknown> = {}
  const ns = nodeId.replace(/[^a-z0-9]/gi, '-') // safe namespace prefix

  // Discrete Inputs — read-only digital status bits (FC 02)
  for (let i = 0; i < 4; i++) {
    const id = `${ns}-di-${i}`
    tags[id] = {
      id,
      name: `DI_${i}`,
      type: 'Bool',
      address: i + 1,
      memaddress: MODBUS_TABLE.discreteInput
    }
  }

  // Coils — writable digital outputs (FC 01 read / FC 05 write single / FC 15 write multiple)
  for (let i = 0; i < 4; i++) {
    const id = `${ns}-do-${i}`
    tags[id] = { id, name: `DO_${i}`, type: 'Bool', address: i + 1, memaddress: MODBUS_TABLE.coil }
  }

  // Input Registers — read-only 16-bit measurements (FC 04)
  for (let i = 0; i < 4; i++) {
    const id = `${ns}-ir-${i}`
    tags[id] = {
      id,
      name: `IR_${i}`,
      type: 'Int16',
      address: i + 1,
      memaddress: MODBUS_TABLE.inputRegister
    }
  }

  // Holding Registers — read/write 16-bit setpoints (FC 03 read / FC 06/16 write)
  for (let i = 0; i < 4; i++) {
    const id = `${ns}-hr-${i}`
    tags[id] = {
      id,
      name: `HR_${i}`,
      type: 'Int16',
      address: i + 1,
      memaddress: MODBUS_TABLE.holdingRegister
    }
  }

  return tags
}

// ── FUXA smart-controller provisioning helper ─────────────────────────────────

/**
 * Builds FUXA tags for a smart-controller device's reactive registers.
 *
 * Mirrors exactly what simulate_controller_reactive() in containers/modbus/server.py
 * drives: CO0 is the command coil (write 1 to start/open, 0 to stop/close), DI0 mirrors
 * it as status feedback, HR0 is the kind's live value (rated flow/max frequency/position
 * %). wellhead-controller is the one kind with no coupled physics — HR0/HR1 are direct
 * read/write setpoints instead, so it gets those two registers and no coil/status pair.
 *
 * @param nodeId - Canvas node ID of the smart-controller device.
 * @param device - The device's full config; must have .controller set (defensive no-op if not).
 * @returns Record of tag objects keyed by tag ID, ready for the FUXA /api/device payload.
 */
function buildControllerModbusTags(nodeId: string, device: DeviceConfig): Record<string, unknown> {
  const controller = device.controller
  if (!controller) return {}
  const ns = nodeId.replace(/[^a-z0-9]/gi, '-')

  if (controller.kind === 'wellhead-controller') {
    return {
      [`${ns}-hr0`]: {
        id: `${ns}-hr0`,
        name: 'HR0',
        type: 'Int16',
        address: 1,
        memaddress: MODBUS_TABLE.holdingRegister
      },
      [`${ns}-hr1`]: {
        id: `${ns}-hr1`,
        name: 'HR1',
        type: 'Int16',
        address: 2,
        memaddress: MODBUS_TABLE.holdingRegister
      }
    }
  }

  return {
    [`${ns}-co0`]: {
      id: `${ns}-co0`,
      name: 'CO0',
      type: 'Bool',
      address: 1,
      memaddress: MODBUS_TABLE.coil
    },
    [`${ns}-di0`]: {
      id: `${ns}-di0`,
      name: 'DI0',
      type: 'Bool',
      address: 1,
      memaddress: MODBUS_TABLE.discreteInput
    },
    [`${ns}-hr0`]: {
      id: `${ns}-hr0`,
      name: 'HR0',
      type: 'Int16',
      address: 1,
      memaddress: MODBUS_TABLE.holdingRegister
    }
  }
}

/**
 * Generates a FUXA view object showing one information card per RTU device.
 *
 * Each card displays the RTU's display name, IP address, and the telemetry
 * communication type from the RTU panel (cellular, radio, satellite, MQTT, or
 * DNP3-Serial). Cards are laid out left-to-right, wrapping every three columns.
 *
 * The view is posted to FUXA's /api/view endpoint after all devices are
 * provisioned. FUXA stores it alongside auto-created views so students see it
 * immediately when they open the HMI — no manual view creation required.
 *
 * @param rtuEntries - Array of [nodeId, DeviceConfig] pairs for RTU/iec104-rtu devices.
 * @returns Plain object matching FUXA's view schema, ready to JSON.stringify.
 */
function buildRtuOverviewView(
  rtuEntries: Array<[string, OTForgeScenario['devices']['devices'][string]]>
): unknown {
  const CARD_W = 420
  const CARD_H = 200
  const COLS = 3
  const GAP = 24
  const MARGIN = 48
  const HEADER_H = 90 // vertical space reserved for the view title

  // Every element here is purely decorative (no live binding) -- raw SVG markup
  // directly in svgcontent, no `items` entries. Confirmed against FUXA's actual view
  // renderer (fuxa-view.component.ts sets dataContainer.innerHTML = view.svgcontent
  // directly; `items` is pure binding metadata matched to existing elements by id,
  // never a separate render path) and visually via a headless-browser screenshot: an
  // items-only entry with no svgcontent backing never appears, regardless of type.
  const svgParts: string[] = [
    `<text x="${MARGIN}" y="${MARGIN + 26}" font-size="26" font-weight="bold" fill="#58a6ff">RTU Station Overview</text>`,
    `<text x="${MARGIN}" y="${MARGIN + 58}" font-size="13" fill="#8b949e">Live Modbus telemetry - tags poll every 1 s</text>`
  ]

  rtuEntries.forEach(([nodeId, device], i) => {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const x = MARGIN + col * (CARD_W + GAP)
    const y = MARGIN + HEADER_H + row * (CARD_H + GAP)
    const ip = device.ipAddress.split('/')[0]
    const commType = (device.rtuConfig?.commType ?? 'modbus-tcp').toUpperCase()
    const protocol = (device.rtuConfig?.primaryProtocol ?? 'DNP3').toUpperCase()
    const power = device.rtuConfig?.powerSource ?? ''
    const displayName = device.label ?? nodeId

    svgParts.push(
      `<rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" fill="#161b22" stroke="#30363d" stroke-width="1"/>`,
      `<circle cx="${x + CARD_W - 21}" cy="${y + 25}" r="7" fill="#3fb950" stroke="#238636" stroke-width="1"/>`,
      `<text x="${x + 18}" y="${y + 38}" font-size="17" font-weight="bold" fill="#e6edf3">${displayName}</text>`,
      `<text x="${x + 18}" y="${y + 70}" font-size="12" fill="#8b949e">IP: ${ip}   Port: 502</text>`,
      `<text x="${x + 18}" y="${y + 98}" font-size="12" fill="#8b949e">Comm: ${commType}   Protocol: ${protocol}</text>`
    )

    if (power) {
      svgParts.push(
        `<text x="${x + 18}" y="${y + 122}" font-size="12" fill="#8b949e">Power: ${power}</text>`
      )
    }

    svgParts.push(
      `<line x1="${x + 18}" y1="${y + CARD_H - 50}" x2="${x + CARD_W - 18}" y2="${y + CARD_H - 50}" stroke="#30363d" stroke-width="1"/>`,
      `<text x="${x + 18}" y="${y + CARD_H - 18}" font-size="11" fill="#6e7681">Tags: DIx0-03  DOx0-03  IRx0-03  HRx0-03</text>`
    )
  })

  const totalRows = Math.ceil(rtuEntries.length / COLS)
  const viewHeight = MARGIN + HEADER_H + totalRows * (CARD_H + GAP) + MARGIN
  const viewWidth = MARGIN + COLS * (CARD_W + GAP) + MARGIN

  return {
    id: 'otf-rtu-overview',
    name: 'RTU Overview',
    profile: {
      width: Math.max(1400, viewWidth),
      height: Math.max(720, viewHeight),
      bkcolor: '#0d1117ff'
    },
    type: 'svg',
    svgcontent: `<svg width="${Math.max(1400, viewWidth)}" height="${Math.max(720, viewHeight)}" xmlns="http://www.w3.org/2000/svg"><g>${svgParts.join('')}</g></svg>`,
    items: {},
    variables: {}
  }
}

// ── FUXA SCADA Overview view generator (OT-zone only) ─────────────────────────

const SCADA_VIEW_WIDTH = 1600
const SCADA_VIEW_HEIGHT = 1000
const SCADA_VIEW_MARGIN = 100
// Vertical space reserved for the centered title before any device renders, so
// devices never crowd up against it.
const SCADA_HEADER_HEIGHT = 110

/**
 * Live-bound running/stopped colors shared by every pump/vfd/actuator/valve shape.
 * Bound to DI0 (status feedback), not CO0 (last-commanded value) -- DI0 reflects what
 * the device actually confirmed, matching simulate_controller_reactive()'s contract.
 */
const SCADA_RUNNING_RANGES = [
  { min: 0, max: 0, color: '#f85149', stroke: '#f85149', text: 'STOPPED' },
  { min: 1, max: 1, color: '#3fb950', stroke: '#3fb950', text: 'RUNNING' }
]

/** Pipe color per fluid type, mirroring FLUID_COLORS in PipeEdge.tsx. */
const SCADA_FLUID_COLORS: Record<string, string> = {
  electric: '#d29922',
  water: '#388bfd',
  gas: '#f78166',
  oil: '#a371f7',
  chemical: '#39d0b0',
  none: '#586069'
}

/**
 * Maps each OT-zone node's canvas position into the fixed SCADA view canvas,
 * preserving relative layout so the generated view mirrors the author's arrangement.
 * Uniform scale (not stretched per-axis) keeps device icons looking correct; capped at
 * 2x so a sparse two-device layout doesn't blow up into giant icons.
 */
function normalizeScadaPositions(nodes: OtZoneDevice[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  if (nodes.length === 0) return positions

  const xs = nodes.map(n => n.node.position.x)
  const ys = nodes.map(n => n.node.position.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = Math.max(maxX - minX, 1)
  const spanY = Math.max(maxY - minY, 1)
  const usableW = SCADA_VIEW_WIDTH - 2 * SCADA_VIEW_MARGIN
  const usableH = SCADA_VIEW_HEIGHT - SCADA_HEADER_HEIGHT - SCADA_VIEW_MARGIN
  const scale = Math.min(usableW / spanX, usableH / spanY, 2)

  for (const { node } of nodes) {
    positions.set(node.id, {
      x: SCADA_VIEW_MARGIN + (node.position.x - minX) * scale,
      y: SCADA_HEADER_HEIGHT + (node.position.y - minY) * scale
    })
  }
  return positions
}

/**
 * Builds a live-bound device shape: the <g> SVG markup (drawn with absolute
 * coordinates, no transform needed) plus the matching `svg-ext-shapes` item FUXA
 * needs to apply property.ranges-based fill/stroke color on tag value changes.
 * Confirmed live against a real container: GaugeBaseComponent.walkTreeNodeToSetAttribute
 * recolors every child element inside the <g>, so multi-element icons work fine.
 */
function buildLiveShape(
  gid: string,
  svgInner: string,
  cx: number,
  cy: number,
  w: number,
  h: number,
  tagId: string,
  label: string
): { svg: string; item: Record<string, unknown> } {
  return {
    svg: `<g id="${gid}" type="svg-ext-shapes">${svgInner}</g>`,
    item: {
      id: gid,
      type: 'svg-ext-shapes',
      name: label,
      label,
      x: cx - w / 2,
      y: cy - h / 2,
      w,
      h,
      rotation: 0,
      property: {
        variableId: tagId,
        bitmask: 0,
        permission: 0,
        permissionRoles: { show: [], enabled: [] },
        ranges: SCADA_RUNNING_RANGES,
        actions: []
      }
    }
  }
}

/** Pump/VFD/actuator icon -- a single fillable circle, mirroring PumpSvg's body. */
function buildPumpShape(gid: string, cx: number, cy: number, tagId: string, label: string) {
  const svg = `<circle cx="${cx}" cy="${cy}" r="32" fill="#6e7681" stroke="#30363d" stroke-width="3"/>`
  return buildLiveShape(gid, svg, cx, cy, 64, 64, tagId, label)
}

/** Valve icon -- two opposing triangles (bowtie), mirroring ValveSvg. */
function buildValveShape(gid: string, cx: number, cy: number, tagId: string, label: string) {
  const svg =
    `<polygon points="${cx - 28},${cy - 18} ${cx},${cy} ${cx - 28},${cy + 18}" fill="#6e7681" stroke="#30363d" stroke-width="2"/>` +
    `<polygon points="${cx + 28},${cy - 18} ${cx},${cy} ${cx + 28},${cy + 18}" fill="#6e7681" stroke="#30363d" stroke-width="2"/>`
  return buildLiveShape(gid, svg, cx, cy, 56, 36, tagId, label)
}

/**
 * Static fallback for OT categories with no clean live boolean to color by yet
 * (sensors, PLCs/RTUs, wellhead-controller's setpoint-only registers). Plain SVG rect,
 * decorative only -- no `items` entry needed (see buildScadaOverviewView's note on why).
 */
function buildFallbackSvg(cx: number, cy: number): string {
  return `<rect x="${cx - 30}" y="${cy - 24}" width="60" height="48" rx="4" fill="#388bfd" stroke="#1f6feb" stroke-width="2"/>`
}

/**
 * Large static tank body for process-unit devices, mirroring ProcessUnitSvg's
 * proportions (rounded vessel + level-gauge bar + inlet/outlet stubs). Decorative
 * only -- process-unit devices run their own physics container, not provisioned as a
 * Modbus tag here, so there's nothing live to bind a level indicator to yet.
 */
function buildTankSvg(cx: number, cy: number): string {
  const w = 90
  const h = 70
  const left = cx - w / 2
  const top = cy - h / 2
  return (
    `<rect x="${left}" y="${top}" width="${w}" height="${h}" rx="8" fill="#21262d" stroke="#8b949e" stroke-width="3"/>` +
    `<rect x="${left + 8}" y="${top + h - 22}" width="${w - 16}" height="${h - 30}" fill="#388bfd" opacity="0.6"/>` +
    `<line x1="${left - 16}" y1="${cy}" x2="${left}" y2="${cy}" stroke="#8b949e" stroke-width="3"/>` +
    `<line x1="${left + w}" y1="${cy}" x2="${left + w + 16}" y2="${cy}" stroke="#8b949e" stroke-width="3"/>`
  )
}

/**
 * Generates the auto-generated SCADA Overview FUXA view: a P&ID-style diagram scoped
 * to OT-zone devices only, with pump/valve icons colored live from their DI0 status
 * tag and pipe runs connecting them per the canvas topology.
 *
 * @param topology - OT-zone nodes/edges from getOtZoneTopology().
 * @returns Plain object matching FUXA's view schema, ready for postView().
 */
function buildScadaOverviewView(topology: OtZoneTopology): unknown {
  const positions = normalizeScadaPositions(topology.nodes)
  const svgParts: string[] = []
  const items: Record<string, unknown> = {}

  // Title: plain static SVG text. Verified against FUXA's actual view renderer
  // (fuxa-view.component.ts sets dataContainer.innerHTML = view.svgcontent directly —
  // `items` is pure binding metadata matched to existing elements by id, never a
  // separate render path) — purely decorative text needs no `items` entry at all, only
  // real markup in svgcontent. Confirmed visually via a headless-browser screenshot:
  // an items-only entry with no svgcontent backing never appears, regardless of type.
  svgParts.push(
    `<text x="${SCADA_VIEW_WIDTH / 2}" y="50" font-size="28" font-weight="bold" fill="#58a6ff" text-anchor="middle">SCADA Dashboard</text>`
  )

  // Pipe runs first so device shapes render on top of them.
  for (const edge of topology.edges) {
    const a = positions.get(edge.source)
    const b = positions.get(edge.target)
    if (!a || !b) continue
    const color = SCADA_FLUID_COLORS[edge.data.fluidType ?? 'none'] ?? SCADA_FLUID_COLORS.none
    // Single right-angle bend on whichever axis dominates, mirroring bestHandles()'s
    // dominant-axis routing in ScadaCanvas.tsx.
    const horizontalDominant = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
    const bendX = horizontalDominant ? b.x : a.x
    const bendY = horizontalDominant ? a.y : b.y
    svgParts.push(
      `<polyline points="${a.x},${a.y} ${bendX},${bendY} ${b.x},${b.y}" fill="none" stroke="${color}" stroke-width="3"/>`
    )
  }

  for (const { node, device } of topology.nodes) {
    const pos = positions.get(node.id)
    if (!pos) continue
    const ns = node.id.replace(/[^a-z0-9]/gi, '-')
    const gid = `otf-scada-${ns}`
    const label = device.label ?? node.id
    const kind = device.controller?.kind
    let labelY = pos.y + 42

    if (device.category === 'smart-controller' && kind === 'valve') {
      const { svg, item } = buildValveShape(gid, pos.x, pos.y, `${ns}-di0`, label)
      svgParts.push(svg)
      items[gid] = item
    } else if (
      device.category === 'smart-controller' &&
      (kind === 'pump' || kind === 'vfd' || kind === 'actuator')
    ) {
      const { svg, item } = buildPumpShape(gid, pos.x, pos.y, `${ns}-di0`, label)
      svgParts.push(svg)
      items[gid] = item
    } else if (device.category === 'process-unit') {
      // Large static tank body — no live binding wired into FUXA for process-unit
      // devices yet (they run their own physics container, not provisioned as a
      // Modbus tag here), so this is decorative only, matching ProcessUnitSvg's
      // proportions (a vessel should read as visually bigger than a field device).
      svgParts.push(buildTankSvg(pos.x, pos.y))
      labelY = pos.y + 62
    } else {
      svgParts.push(buildFallbackSvg(pos.x, pos.y))
    }

    svgParts.push(
      `<text x="${pos.x}" y="${labelY}" font-size="12" fill="#e6edf3" text-anchor="middle">${label}</text>`
    )
  }

  return {
    id: 'otf-scada-overview',
    name: 'SCADA Overview',
    profile: { width: SCADA_VIEW_WIDTH, height: SCADA_VIEW_HEIGHT, bkcolor: '#0d1117ff' },
    type: 'svg',
    svgcontent: `<svg width="${SCADA_VIEW_WIDTH}" height="${SCADA_VIEW_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><g>${svgParts.join('')}</g></svg>`,
    items,
    variables: {}
  }
}

/**
 * Builds one FUXA alarm per pump/vfd/actuator smart-controller device, bound to its
 * DI0 status tag: DI0=0 ("stopped") is the alarm condition, matching the reference
 * screenshot's "Pump 2 has stopped working" exactly. Valves are intentionally excluded
 * -- a closed valve (DI0=0) is frequently the normal state, not a fault, so auto-firing
 * an alarm on it would be misleading. wellhead-controller has no DI0 to bind to.
 *
 * @param nodes - OT-zone nodes from getOtZoneTopology().
 * @returns Array of Alarm-shaped objects, ready for postAlarm().
 */
function buildScadaAlarms(nodes: OtZoneDevice[]): unknown[] {
  const alarms: unknown[] = []

  for (const { node, device } of nodes) {
    if (device.category !== 'smart-controller') continue
    const kind = device.controller?.kind
    if (kind !== 'pump' && kind !== 'vfd' && kind !== 'actuator') continue

    const ns = node.id.replace(/[^a-z0-9]/gi, '-')
    const label = device.label ?? node.id

    alarms.push({
      name: `otf-scada-alarm-${ns}-stopped`,
      property: {
        variableId: `${ns}-di0`,
        permission: 0,
        permissionRoles: { show: [], enabled: [] }
      },
      low: {
        enabled: true,
        checkdelay: 1,
        min: 0,
        max: 0,
        timedelay: 0,
        text: `${label} has stopped working`,
        group: 'process',
        ackmode: 'alarm.ack-active',
        bkcolor: '#d29922',
        color: '#0d1117'
      },
      high: {},
      highhigh: {},
      info: {},
      actions: { enabled: false, values: [] },
      value: ''
    })
  }

  return alarms
}

// ── OpenPLC HTTP API helpers ───────────────────────────────────────────────────
//
// These helpers implement the OpenPLC Runtime v3 web API using Node.js's built-in
// `http` module. The native module is used (rather than global `fetch`) because it
// gives us direct access to individual Set-Cookie headers without the redirect
// handling complexities of the Fetch API's cookie model.
//
// OpenPLC Runtime v3 web API summary (Flask backend):
//   POST /login                  — Form auth: username + password → session cookie
//   POST /upload-program         — Multipart file upload: field name = "file"
//   GET  /start_plc              — Compile uploaded file and start scan cycle
//   GET  /stop_plc               — Halt scan cycle (program remains loaded)
//   GET  /dashboard              — HTML status page (scraped for PLC Status text)
//
// Default credentials installed by install.sh: openplc / openplc
// These are intentionally weak — lab environments rotate them via the web UI.

/**
 * Makes a raw HTTP GET request and returns the response body as a string.
 *
 * @param url - Full URL to GET (http://localhost:PORT/path).
 * @returns Response body text.
 * @throws If the connection is refused or times out.
 */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = ''
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString()
      })
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    // 5-second timeout — containers may be slow to respond during startup
    req.setTimeout(5000, () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })
  })
}

/**
 * Makes an HTTP POST request with a raw body and returns status code,
 * response headers, and body text.
 *
 * @param options - Node.js http.RequestOptions (host, port, path, headers).
 * @param body    - Request body as a string.
 */
function httpPost(
  options: http.RequestOptions,
  body: string
): Promise<{ statusCode: number; headers: http.IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let data = ''
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString()
      })
      res.on('end', () =>
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: data })
      )
    })
    req.on('error', reject)
    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })
    req.write(body)
    req.end()
  })
}

/**
 * Deploys a Structured Text program to a running OpenPLC Runtime container.
 *
 * Authentication flow:
 *   1. POST /login with form-encoded credentials → 302 redirect with Set-Cookie
 *   2. All subsequent requests carry the session cookie in the Cookie header
 *
 * Upload flow:
 *   3. POST /upload-program with multipart/form-data body containing the .st file
 *   4. GET /start_plc to recompile and restart the PLC scan cycle
 *
 * The multipart body is constructed manually (without a form-data library) to
 * avoid adding a production runtime dependency to the main process.
 *
 * @param hostPort - Host-side published port for the container's port 8080.
 * @param source   - Raw ST source text (UTF-8, not base64).
 * @param nodeId   - Device node ID, used as the uploaded filename.
 * @returns PLCDeployResult with compiler output or error message.
 */
async function deployToOpenPLC(
  hostPort: number,
  source: string,
  nodeId: string
): Promise<PLCDeployResult> {
  const host = 'localhost'

  // Step 1: Login — POST /login with URL-encoded form body
  const loginBody = `username=openplc&password=openplc`
  const loginResp = await httpPost(
    {
      host,
      port: hostPort,
      path: '/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(loginBody)
      }
    },
    loginBody
  )

  // Extract session cookie from the login response (Flask sets it on the 302 redirect).
  // Node.js types set-cookie as string[] | undefined — it is always an array when present.
  const rawCookie = loginResp.headers['set-cookie']
  const sessionCookie = rawCookie ? rawCookie.map(c => c.split(';')[0]).join('; ') : ''

  if (!sessionCookie) {
    return { ok: false, error: 'Login failed — could not obtain session cookie from OpenPLC.' }
  }

  // Step 2: Upload program — POST /upload-program with multipart/form-data
  // The boundary string separates the multipart body parts.
  const boundary = `----ICSSimBoundary${Date.now()}`
  const filename = `${nodeId}.st`
  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `${source}\r\n` +
    `--${boundary}--\r\n`

  const uploadResp = await httpPost(
    {
      host,
      port: hostPort,
      path: '/upload-program',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(multipartBody),
        Cookie: sessionCookie
      }
    },
    multipartBody
  )

  // Step 3: Start PLC — GET /start_plc triggers compile + scan cycle restart
  // The response is an HTML page with compilation output; we extract the log text.
  let compileOutput = ''
  try {
    const startBody = await httpGet(`http://${host}:${hostPort}/start_plc`)
    // Scrape the compile log from the HTML (appears between <pre> tags in OpenPLC v3)
    const preMatch = startBody.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)
    compileOutput = preMatch ? preMatch[1].trim() : ''
  } catch {
    // /start_plc may redirect — treat as success if upload succeeded
  }

  const uploadOk = uploadResp.statusCode < 400
  return {
    ok: uploadOk,
    output: compileOutput || (uploadOk ? 'Program uploaded and PLC restarted.' : undefined),
    error: uploadOk ? undefined : `Upload failed (HTTP ${uploadResp.statusCode})`
  }
}
