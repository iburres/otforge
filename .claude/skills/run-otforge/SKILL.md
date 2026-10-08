---
name: run-otforge
description: Build, run, and drive the OTForge Electron desktop app. Use when asked to start OTForge, launch the app, open a scenario/.otflab, click through the UI, screenshot it, verify a UI change in the real app, or run its tests.
---

OTForge is an Electron app (`packages/app`) on two workspace libraries (`packages/schema`,
`packages/orchestrator`). Agents drive the **built** app with the Playwright command driver
at `.claude/skills/run-otforge/driver.mjs`: pipe it one command per line, it runs them in
order and prints one result line each. It opens scenarios, selects canvas nodes, fills
fields and takes screenshots.

All paths are relative to the repo root. Verified on Windows 11 (Git Bash), Node 24,
Electron 42, Docker Desktop 28. It drives a real window on the desktop. It has not been
run on headless Linux; there you would wrap it in `xvfb-run -a`.

## Setup (once)

```bash
npm install                                                          # repo deps (no lockfile, by design; was already installed when this skill was written)
(cd .claude/skills/run-otforge && npm install --no-package-lock)     # driver's playwright-core
```

## Build

The app runs from `packages/app/out/`. Rebuild after **any** source change, including
changes to schema or orchestrator. The app imports those two packages from their `dist/`,
not from source.

```bash
npm run build:packages                       # schema + orchestrator -> dist/
(cd packages/app && npx electron-vite build) # app -> packages/app/out/   (~7 s total)
```

Do **not** use `npm run build` in `packages/app`: it also runs electron-builder and
produces an installer.

## Run (agent path)

```bash
printf '%s\n' \
  'launch' \
  'open scenarios/ICS_Lab_03.otflab' \
  'close-tutorial' \
  'select ids-1' \
  'fill Custom Suricata rules|alert tcp any any -> any 502 (msg:"ok"; sid:9100001; rev:1;)\nalert tcp any any -> any 502 (msg:"typo"; conten:"x"; sid:9100002; rev:1;)' \
  'click-text Save Rules' \
  'wait .ids-rule-check' \
  'text .ids-rule-check' \
  'ss-el .ids-rule-check rule-check' \
  'ss full' \
  'quit' | node .claude/skills/run-otforge/driver.mjs
```

That whole flow takes about 8 s. Screenshots go to `$SCREENSHOT_DIR`, which defaults to
`<os tmpdir>/otforge-shots`; each `ss` prints the full path. **Open the PNG and look at it.**
A failed command prints `ERROR in "<cmd>": ...` and the script carries on.

| command | what it does |
|---|---|
| `launch` | start the built app; waits for the start screen |
| `open <path.otflab>` | open a scenario. Stubs the native file dialog; path is relative to repo root. Works from the start screen and the toolbar |
| `close-tutorial` | close the floating tutorial panel (see Gotchas) |
| `tab <text>` | click a Purdue layer tab, e.g. `tab Plant DMZ`, `tab OT Process` |
| `select <node-id>` | click a canvas node; searches every layer tab. IDs are `visual.nodes[].id` in the .otflab |
| `fill <aria-label>\|<text>` | fill an input or textarea by aria-label; `\n` in text = newline |
| `click <css>` / `click-text <exact text>` | click |
| `wait <css>` | wait up to 30 s for an element |
| `text [css]` | print innerText (whole page if no selector) |
| `eval <js expr>` | evaluate in the renderer, print JSON |
| `ss [name]` / `ss-el <css> <name>` | screenshot the window or one element |
| `sleep 15s` / `sleep 500ms` | wait; a bare number is **milliseconds** |
| `help`, `quit` | |

Set `MAIN_LOG=<file>` to capture the Electron main process's stdout/stderr.

**Simulations:** `click-text Run Simulation`, then sample with `sleep 10s` + `eval document.querySelector(".status-bar").innerText` until it reads "N/N containers running" (Lab 03: ~25 s), and finish with `click-text Stop Simulation` + `sleep 25s` before `quit`. If the driver dies mid-run, the containers keep running: `docker ps` and remove them.

Typing commands interactively at the `driver>` prompt also works. There is no tmux on
this machine, so piping is the normal path.

### Direct invocation (no GUI)

Orchestrator code (compose generation, Docker calls) can be exercised without the app.
Build first, then `require` the dist:

```bash
node -e 'const { DockerClient } = require("./packages/orchestrator/dist/index.js");
new DockerClient(require("os").tmpdir()).validateSuricataRules("alert tcp any any -> any 1 (msg:\"x\"; sid:9100001; rev:1;)").then(r => console.log(JSON.stringify(r)))'
```

## Run (human path)

```bash
npm run dev   # from package.json, not exercised when this skill was written: builds packages, then electron-vite dev with hot reload
```

## Test

```bash
npm test      # orchestrator vitest suite: 8 files / 254 tests pass (2026-10-08)
```

Type-check, run per package: `(cd packages/orchestrator && npx tsc --noEmit -p .)` and
`(cd packages/app && npm run typecheck)`. Both read sibling packages from `dist/`, so run
`npm run build:packages` first.

## Gotchas

- **The native "Open" file dialog can't be clicked by Playwright.** `open` replaces
  `dialog.showOpenDialog` in the main process (`app.evaluate`) before clicking the button.
  The same trick works for any other dialog.
- **Tutorial scenarios open with a floating tutorial panel over the properties column.**
  Clicks on the properties panel (e.g. Save Rules) fail with "`<td>` from
  `.tutorial-panel` subtree intercepts pointer events". Run `close-tutorial` after `open`.
  A real user would close it too; this isn't an app bug.
- **The SCADA layer tab is disabled until a simulation runs.** Clicking it waits the full
  30 s Playwright timeout. `select` skips disabled tabs; avoid `tab SCADA` unless a
  simulation is running.
- **Canvas node IDs aren't device names.** They're `visual.nodes[].id` (Lab 01's PLC is
  `plc-1`). A bad ID makes `select` list the IDs on the current tab.
- **"Student Mode" doesn't hide the IDS/firewall panels** in the bundled tutorials. They
  render because the scenarios are `"locked": false`.
- **`sleep 15` waits 15 ms, not 15 s.** That once made a normal ~25 s simulation start look like a hang, because the status bar was read 1 s after Run. Always write the unit.
- **Stale `dist/` gives confusing type errors.** For example, `TS2305: Module
  '"@otforge/schema"' has no exported member ...`, or `Property 'X' does not exist on type
  'DockerClient'` from the app. Fix: `npm run build:packages`.
- **Shell escaping of `\` in test strings.** Bash heredocs and `node -e '...'` in Git Bash
  turned `\\\n` into a literal `\n`, which produced a false "invalid rule" result once.
  Build backslashes with `String.fromCharCode(92)` in test scripts.

## Troubleshooting

- **`ERR_USE_AFTER_CLOSE: readline was closed`**: an older driver prompted after piped
  stdin hit EOF. Fixed in the current driver; if you edit it, keep the `inputClosed` guard.
- **`launch` says `packages/app/out/main/index.mjs missing`**: run the Build step.
- **`DeprecationWarning: Passing args to a child process with shell option true`**: comes
  from playwright-core 1.48 launching Electron on Windows. Harmless.
