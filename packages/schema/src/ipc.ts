// Typed IPC channel definitions — the contract between Electron main process and renderer.
// All channels use ipcMain.handle / ipcRenderer.invoke (request-response pattern).
// Event channels (one-way push from main) use the 'on:' prefix.

import type { OTForgeScenario, ResourceEstimate } from './icslab'
import type { InstalledPack } from './icspack'

// ── Request / Response types ───────────────────────────────────────────────────

export interface DockerStatus {
  available: boolean
  version?: string
  message?: string
}

export interface ScenarioImportResult {
  ok: boolean
  scenario?: OTForgeScenario
  error?: string
  resourceEstimate?: ResourceEstimate
  /** Absolute path of the .otflab file that was opened. Used by the renderer to
   *  track which file is currently loaded so the Delete Scenario action can
   *  remove it from disk via the scenario:deleteFile IPC handler. */
  filePath?: string
}

/** Result of the scenario:deleteFile IPC call. */
export interface ScenarioDeleteFileResult {
  ok: boolean
  /** Human-readable description of the error, if any. */
  error?: string
}

export interface ScenarioExportOptions {
  locked: boolean
  filePath?: string // if omitted, opens save dialog
}

export interface ScenarioExportResult {
  ok: boolean
  filePath?: string
  error?: string
}

export interface SimulationStartResult {
  ok: boolean
  error?: string
  containersStarted?: string[]
}

export interface SimulationStopResult {
  ok: boolean
  error?: string
}

/**
 * Lightweight descriptor of a saved student session, returned by session:list.
 * Excludes the full scenario payload so the picker stays cheap to render.
 */
export interface SessionSummary {
  /** Sanitized scenario name — the session's directory key and load handle. */
  projectName: string
  /** Human-readable scenario name (meta.name) shown in the session picker. */
  scenarioName: string
  /** ISO timestamp of when the session was saved. */
  savedAt: string
  /** 0-based tutorial step the student was on when they saved. */
  tutorialStep: number
}

/** Result of session:save. */
export interface SessionSaveResult {
  ok: boolean
  error?: string
}

/** Result of session:load — the restored scenario plus where to resume. */
export interface SessionLoadResult {
  ok: boolean
  scenario?: OTForgeScenario
  tutorialStep?: number
  error?: string
}

export interface ContainerStatus {
  nodeId: string
  containerId?: string
  /**
   * 'restarting' = Docker is between restart attempts (restart policy after a crash).
   * A crash-looping container alternates between 'running' and 'restarting', so on
   * its own this field can't be trusted to show the problem. Use restartCount too.
   */
  status: 'running' | 'stopped' | 'error' | 'starting' | 'restarting'
  healthCheck?: 'healthy' | 'unhealthy' | 'starting'
  /**
   * How many times Docker has restarted this container since it was created (from
   * `docker inspect`). Anything above 0 means it died on its own at least once.
   * Absent when the count couldn't be read.
   */
  restartCount?: number
  /** Exit code of the last crash, when Docker reports it (only while 'restarting'). */
  lastExitCode?: number
}

export interface LicenseValidationResult {
  valid: boolean
  userId?: string
  packScopes?: string[]
  expiresAt?: string
  error?: string
}

export interface AppInfo {
  version: string
  nodeVersion: string
  electronVersion: string
  platform: 'win32' | 'darwin' | 'linux'
  /**
   * True when running via `npm run dev` (electron-vite dev server) from a git
   * checkout. False in a packaged build. The "Update OTForge" self-updater
   * (app:update) only works in dev mode — a packaged build has no .git
   * directory or workspace package.json to update.
   */
  isDev: boolean
}

/**
 * Result of the "Update OTForge" self-updater (app:update): `git pull` +
 * `npm install` in the project root, then (when a scenario is loaded and
 * Docker is available) a `docker compose pull` for that scenario's images.
 *
 * `restartRequired` reflects whether `git pull` actually moved the local
 * HEAD commit — i.e. whether source changed and the running process is now
 * stale. The main process itself decides what to do with this: it shows a
 * native "restart required" or "already up to date" dialog and, when a
 * restart is required, calls app.exit() right after the user dismisses the
 * dialog. The renderer does not need to react to this field at all — by the
 * time app:update's promise resolves, the user has already been told
 * everything they need to know.
 *
 * `imageRefresh` reflects the SEPARATE outcome of the container image pull
 * step, which does not affect `ok`/`restartRequired` at all — a scenario
 * not being loaded, Docker not running, or `docker compose pull` failing are
 * all still reported as an overall successful update, since the source/
 * dependency update genuinely did succeed independently. This field exists
 * so the main process's own dialog can say so honestly instead of always
 * showing the same "up to date" message regardless of whether images were
 * actually refreshed — a scenario that silently never got its images
 * updated looks identical to a fully-current one otherwise.
 */
export interface AppUpdateResult {
  ok: boolean
  error?: string
  restartRequired?: boolean
  imageRefresh?: 'ok' | 'failed' | 'skipped-no-scenario' | 'skipped-no-docker'
  imageRefreshError?: string
}

// ── PLC firmware import (Phase 9 add-on) ──────────────────────────────────────

/**
 * A single variable extracted from a PLC project file.
 *
 * IEC addresses are populated for formats that carry them (PLCopen XML, plain ST).
 * L5X (Logix Designer) does not use IEC addressing — address will be an empty string
 * and the renderer assigns defaults based on type and position.
 */
export interface ImportedVariable {
  /** IEC 61131-3 variable name, e.g. "pump_run". */
  name: string
  /**
   * Normalized IEC type: "BOOL" | "INT" | "DINT" | "REAL" | "WORD".
   * Logix/non-standard types are mapped to the closest IEC equivalent.
   */
  type: string
  /**
   * IEC 61131-3 I/O address, e.g. "%QX0.0" or "%IW0".
   * Empty string when the source format does not use IEC addressing (L5X).
   */
  address: string
  /** Comment or description extracted from the variable declaration. */
  comment: string
}

/**
 * One importable routine/POU extracted from a PLC project file.
 *
 * For L5X files (Logix Designer) this maps to a <Routine Type="ST"> element.
 * For PLCopen XML this maps to a <pou pouType="program|functionBlock"> element.
 * For plain .st/.scl files this is the whole file as a single routine.
 */
export interface ImportedRoutine {
  /** Routine name from the source file, e.g. "MainRoutine" or "main". */
  name: string
  /** Decoded ST source text, ready to paste into the OpenPLC IDE editor. */
  source: string
  /** Variables extracted from the file — pre-populates the variable binding table. */
  variables: ImportedVariable[]
  /**
   * Source format descriptor shown in the routine picker UI.
   * Examples: "st", "l5x-st", "plcopen-st"
   */
  sourceFormat: string
  /**
   * Non-fatal parse warnings shown to the user.
   * Common examples: Ladder routines that were skipped, unmapped data types.
   */
  warnings: string[]
}

/**
 * Return value of the plc:importProgram IPC handler.
 *
 * On success, `routines` contains one or more importable routines found in the file.
 * Multiple routines (e.g., from a multi-routine L5X file) are presented in a picker
 * so the user can choose which one to load into the editor.
 */
export interface PlcImportResult {
  ok: boolean
  /** Extracted routines — one per ST/SCL POU found in the source file. */
  routines?: ImportedRoutine[]
  /** Original filename without the path — shown in the status message after import. */
  fileName?: string
  error?: string
}

// ── Scenario pack (Phase 9) ────────────────────────────────────────────────────

/**
 * Result of installing a community scenario pack from a .otfpack ZIP file.
 * On success, `pack` contains the fully-resolved InstalledPack ready for use.
 */
export interface PackInstallResult {
  ok: boolean
  pack?: InstalledPack
  error?: string
}

/**
 * List of all packs currently installed in <userData>/packs/.
 * Empty array when no packs are installed.
 */
export interface PackListResult {
  packs: InstalledPack[]
}

/** Result of uninstalling a pack — removes all bundled assets from disk. */
export interface PackUninstallResult {
  ok: boolean
  error?: string
}

// ── PLC IDE (Phase 4) ──────────────────────────────────────────────────────────

/**
 * Result of uploading and compiling a Structured Text program to a running
 * OpenPLC Runtime container. The `output` field carries compiler stdout so the
 * IDE panel can display any warnings or errors to the user.
 */
export interface PLCDeployResult {
  ok: boolean
  /** Raw compiler output lines from the IEC 61131-3 → C transpiler. */
  output?: string
  error?: string
}

/**
 * Runtime state of the OpenPLC execution engine inside a container.
 * Polled by the IDE panel to show whether the PLC is actively running a program.
 */
export interface PLCRuntimeStatus {
  nodeId: string
  /** True when OpenPLC Runtime is executing a program (not stopped or crashed). */
  running: boolean
  /** Name of the currently loaded program file (without extension). */
  program?: string
  error?: string
}

// ── IPC Channel map ────────────────────────────────────────────────────────────
// Keyed by channel name. Value is [RequestArgs, ResponseType].
// Used to type contextBridge exposure and ipcMain.handle registration.

export interface IPCChannels {
  // Docker
  'docker:check': [void, DockerStatus]
  'docker:version': [void, string]

  // Scenario management
  'scenario:import': [void, ScenarioImportResult]
  'scenario:export': [
    { scenario: OTForgeScenario; options: ScenarioExportOptions },
    ScenarioExportResult
  ]
  'scenario:validate': [OTForgeScenario, { valid: boolean; errors: string[] }]
  /** Deletes the .otflab file at the given absolute path from disk.
   *  Called by the renderer after the user confirms the Delete Scenario action. */
  'scenario:deleteFile': [{ filePath: string }, ScenarioDeleteFileResult]

  // Simulation lifecycle
  'simulation:start': [OTForgeScenario, SimulationStartResult]
  'simulation:stop': [void, SimulationStopResult]
  'simulation:status': [void, ContainerStatus[]]

  // License
  'license:validate': [{ key: string }, LicenseValidationResult]
  'license:info': [void, LicenseValidationResult]

  // App
  'app:info': [void, AppInfo]
  'app:openExternal': [{ url: string }, void]

  // PLC IDE (Phase 4)
  /**
   * Uploads a Structured Text source string to the running OpenPLC container
   * for the given device nodeId. The main process locates the container by
   * its published web port, authenticates to OpenPLC, uploads the file, and
   * triggers recompilation + PLC restart.
   */
  'plc:deploy': [{ nodeId: string; source: string }, PLCDeployResult]

  /**
   * Returns the execution state of the OpenPLC runtime inside the given
   * device's container. Used by the IDE panel to show run/stopped status.
   */
  'plc:status': [{ nodeId: string }, PLCRuntimeStatus]

  /**
   * Opens a native file picker filtered to .l5x, .xml, .export, .st, and .scl
   * files, parses the selected PLC project file, and returns one or more
   * importable ST routines found in it. Supports:
   *   - Rockwell Logix Designer L5X (.l5x) — extracts <Routine Type="ST"> elements
   *   - PLCopen XML (.xml, .export) — extracts <pou pouType="program|functionBlock"> ST bodies
   *   - Plain IEC 61131-3 ST / SCL source (.st, .scl) — treated as a single routine
   * Ladder (RLL) and FBD routines are skipped with a warning; the user is
   * informed via PlcImportResult.routines[].warnings.
   */
  'plc:importProgram': [void, PlcImportResult]

  // Community scenario packs (Phase 9)
  /**
   * Opens a native file picker for .otfpack files, extracts the ZIP to
   * <userData>/packs/<packId>/, validates the manifest, and returns the
   * resolved InstalledPack with pre-loaded icon data URLs.
   */
  'pack:install': [void, PackInstallResult]

  /**
   * Scans <userData>/packs/ and returns every installed pack with its
   * resolved device types and scenario metas.
   */
  'pack:list': [void, PackListResult]

  /**
   * Deletes the pack directory at <userData>/packs/<packId>/ and all its contents.
   * @param packId - The pack.id from the pack manifest.
   */
  'pack:uninstall': [{ packId: string }, PackUninstallResult]

  /**
   * Loads a bundled .otflab scenario from inside the given pack, validates it,
   * and returns it as a ScenarioImportResult so the renderer can open it directly.
   *
   * @param packId       - The pack whose scenario to load.
   * @param relativePath - Relative path from the pack root (matches manifest.scenarios entry).
   */
  'pack:openScenario': [{ packId: string; relativePath: string }, ScenarioImportResult]
}

// ── One-way event channels (main → renderer) ───────────────────────────────────

export interface IPCEvents {
  'container:statusUpdate': ContainerStatus
  'simulation:log': { nodeId: string; level: 'info' | 'warn' | 'error'; message: string }
  'docker:error': { message: string }
}

// Helper types for consumers
export type IPCChannelName = keyof IPCChannels
export type IPCEventName = keyof IPCEvents
export type IPCRequest<K extends IPCChannelName> = IPCChannels[K][0]
export type IPCResponse<K extends IPCChannelName> = IPCChannels[K][1]
