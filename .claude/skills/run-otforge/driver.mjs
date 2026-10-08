// driver.mjs — Command driver for the OTForge Electron app (agent tooling).
//
// Launches the BUILT app (packages/app/out/) through Playwright's _electron API and
// executes one command per line from stdin, strictly in order (each command finishes
// before the next starts, so piped scripts are deterministic). Works both piped:
//
//   printf 'launch\nopen scenarios/ICS_Lab_03.otflab\nss lab03\nquit\n' | node .claude/skills/run-otforge/driver.mjs
//
// and interactively (type commands at the "driver>" prompt).
//
// Screenshots go to $SCREENSHOT_DIR, default <os tmpdir>/otforge-shots.
// Run `help` for the command list; SKILL.md documents each command.

import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const REPO_DIR = path.resolve(import.meta.dirname, '../../..')
const APP_DIR = path.join(REPO_DIR, 'packages/app')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'otforge-shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

// Requiring the `electron` package from Node returns the path of the Electron
// binary for this platform (electron.exe on Windows). Resolve it from the app.
const electronBin = createRequire(path.join(APP_DIR, 'package.json'))('electron')

let app = null
let page = null

/** Fails the command (not the driver) when the app isn't running. */
function need() {
  if (!page) throw new Error('launch first')
}

/** Decodes \n and \t in command arguments so multi-line text can be passed on one line. */
const unescape = s => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')

/** Splits "first rest of line" into [first, rest]. */
function split1(arg) {
  const i = arg.indexOf(' ')
  return i < 0 ? [arg, ''] : [arg.slice(0, i), arg.slice(i + 1)]
}

const COMMANDS = {
  /** Launch the built app and wait for the start screen ("New Scenario" button). */
  async launch() {
    if (app) return console.log('already launched')
    if (!fs.existsSync(path.join(APP_DIR, 'out/main/index.mjs'))) {
      throw new Error('packages/app/out/main/index.mjs missing: run the Build step in SKILL.md')
    }
    app = await electron.launch({ executablePath: electronBin, args: [APP_DIR], cwd: APP_DIR, timeout: 60_000 })
    // MAIN_LOG=<file>: append the Electron main process's stdout/stderr there. The
    // main process logs Docker/compose activity that never reaches the window.
    if (process.env.MAIN_LOG) {
      const log = fs.createWriteStream(process.env.MAIN_LOG, { flags: 'a' })
      app.process().stdout?.pipe(log)
      app.process().stderr?.pipe(log)
      console.log('main-process log:', process.env.MAIN_LOG)
    }
    page = await app.firstWindow()
    await page.getByText('New Scenario', { exact: true }).first().waitFor({ timeout: 30_000 })
    // The Docker status line fills in asynchronously; give it a moment so `ss` shows it.
    await page.waitForTimeout(1500)
    console.log('launched:', page.url())
  },

  /**
   * Open a .otflab scenario. The real button opens a native file dialog Playwright
   * can't drive, so the main-process dialog is stubbed to return this path first.
   * Path is relative to the repo root (or absolute).
   */
  async open(arg) {
    need()
    const file = path.resolve(REPO_DIR, arg)
    if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`)
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
    }, file)
    // Start screen says "Open .otflab File"; once a scenario is open the toolbar says "Open".
    const startBtn = page.getByText('Open .otflab File', { exact: true })
    if (await startBtn.isVisible().catch(() => false)) await startBtn.click()
    else await page.getByText('Open', { exact: true }).first().click()
    await page.locator('.layer-tab').first().waitFor({ timeout: 15_000 })
    await page.waitForTimeout(1500)
    console.log('opened:', path.basename(file))
  },

  /** Close the floating tutorial panel (it covers the properties column). No-op if absent. */
  async 'close-tutorial'() {
    need()
    const btn = page.locator('.tutorial-panel button', { hasText: /^\s*[×✕x]\s*$/ }).first()
    if (!(await btn.count())) return console.log('no tutorial panel')
    await btn.click()
    console.log('tutorial closed')
  },

  /** Click the Purdue layer tab whose text contains <text> (e.g. "Plant DMZ", "OT Process"). */
  async tab(text) {
    need()
    await page.locator('.layer-tab', { hasText: text }).first().click()
    await page.waitForTimeout(800)
    console.log('tab:', text)
  },

  /**
   * Select a canvas node by its scenario node id (e.g. ids-1, plc-main). If it isn't on
   * the current layer tab, tries each tab in turn. Opens its properties panel.
   */
  async select(id) {
    need()
    const node = page.locator(`.react-flow__node[data-id="${id}"]`)
    if (!(await node.isVisible().catch(() => false))) {
      const tabs = page.locator('.layer-tab')
      for (let i = 0; i < (await tabs.count()); i++) {
        // The SCADA tab is a .layer-tab too, but disabled until a simulation runs;
        // a plain click() would wait 30 s for it to become enabled.
        if (await tabs.nth(i).isDisabled().catch(() => true)) continue
        await tabs.nth(i).click()
        await page.waitForTimeout(600)
        if (await node.isVisible().catch(() => false)) break
      }
    }
    if (!(await node.isVisible().catch(() => false))) {
      // Fail fast with the ids that DO exist, instead of a 30 s click timeout.
      // Canvas ids come from the scenario's visual.nodes[].id, not devices.
      const ids = await page.$$eval('.react-flow__node', ns => ns.map(n => n.getAttribute('data-id')))
      throw new Error(`node "${id}" not found on any layer tab. On this tab: ${ids.join(', ') || '(none)'}`)
    }
    await node.click()
    await page.waitForTimeout(500)
    console.log('selected:', id)
  },

  /** Screenshot the whole window -> $SCREENSHOT_DIR/<name>.png */
  async ss(name) {
    need()
    const f = path.join(SHOT_DIR, `${name || `ss-${Date.now()}`}.png`)
    await page.screenshot({ path: f })
    console.log('screenshot:', f)
  },

  /** Screenshot one element: ss-el <css-selector> <name> */
  async 'ss-el'(arg) {
    need()
    const [sel, name] = split1(arg)
    const f = path.join(SHOT_DIR, `${name || `el-${Date.now()}`}.png`)
    await page.locator(sel).first().screenshot({ path: f })
    console.log('screenshot:', f)
  },

  /** Click the first element matching a CSS selector. */
  async click(sel) {
    need()
    await page.locator(sel).first().click()
    console.log('clicked:', sel)
  },

  /** Click the first button/element whose text is exactly <text>. */
  async 'click-text'(text) {
    need()
    await page.getByText(text, { exact: true }).first().click()
    console.log('clicked text:', text)
  },

  /** Fill an input/textarea by its aria-label: fill <aria-label>|<text>. \n in text = newline. */
  async fill(arg) {
    need()
    const i = arg.indexOf('|')
    if (i < 0) throw new Error('usage: fill <aria-label>|<text>')
    const field = page.getByLabel(arg.slice(0, i), { exact: true })
    await field.scrollIntoViewIfNeeded()
    await field.fill(unescape(arg.slice(i + 1)))
    console.log('filled:', arg.slice(0, i))
  },

  /** Wait (up to 30 s) for a CSS selector to appear. */
  async wait(sel) {
    need()
    await page.locator(sel).first().waitFor({ timeout: 30_000 })
    console.log('found:', sel)
  },

  /** Print innerText of a selector (default: whole page). */
  async text(sel) {
    need()
    console.log(sel ? await page.locator(sel).first().innerText() : await page.locator('body').innerText())
  },

  /** Evaluate JS in the renderer and print the JSON result. */
  async eval(expr) {
    need()
    console.log(JSON.stringify(await page.evaluate(expr)))
  },

  /**
   * Sleep: `sleep 15s`, `sleep 500ms`, or a bare number = milliseconds.
   * Prints what it actually waited: a bare `sleep 15` is 15 ms, which once made a
   * slow simulation start look like a hang.
   */
  async sleep(arg) {
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s)?$/.exec((arg || '1s').trim())
    if (!m) throw new Error('usage: sleep <n>s | <n>ms | <n> (ms)')
    const ms = m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1])
    await new Promise(r => setTimeout(r, ms))
    console.log(`slept ${ms} ms`)
  },

  async quit() {
    if (app) await app.close().catch(() => {})
    app = null
    page = null
  },

  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '))
  }
}

// ── Command loop ────────────────────────────────────────────────────────────────
// readline fires 'line' events without waiting for async handlers, so commands are
// chained on one promise: each starts only after the previous finished. A failing
// command prints ERROR and the chain continues (an agent sees which step failed).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'driver> ' })
let chain = Promise.resolve()
// Piped input hits EOF long before the queued commands finish; prompting after readline
// closes throws ERR_USE_AFTER_CLOSE, so only re-prompt while input is still open.
let inputClosed = false

rl.on('line', line => {
  chain = chain.then(async () => {
    const [cmd, rest] = split1(line.trim())
    if (!cmd || cmd.startsWith('#')) return
    const fn = COMMANDS[cmd]
    if (!fn) return console.log(`unknown: ${cmd}  (try: help)`)
    try {
      await fn(rest)
    } catch (e) {
      console.log(`ERROR in "${cmd}": ${e.message.split('\n')[0]}`)
    }
    if (cmd !== 'quit' && !inputClosed) rl.prompt()
  })
})
rl.on('close', () => {
  inputClosed = true
  chain.then(() => COMMANDS.quit()).then(() => process.exit(0))
})

console.log('OTForge driver: "help" for commands, "launch" to start')
rl.prompt()
