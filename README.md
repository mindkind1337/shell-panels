# Shell Panels

A Windows desktop app for running **multiple shells in one window**, split into
resizable panels, with optional **multi-write (broadcast)** so you can type once
and drive every pane at the same time.

Built with **Electron + Vue 3 + xterm.js + node-pty**.

## Features

- **Multiple real shells in one window** — PowerShell, PowerShell 7, Command
  Prompt, Git Bash and WSL are auto-detected (whichever are installed).
- **Split into panels** — split any pane Right (side-by-side) or Down (stacked),
  nested arbitrarily. Each pane is a full PTY-backed terminal.
- **Even grid presets** — the **Grid…** menu lays everything out as a clean,
  evenly-spaced grid (2×2, 3×2, 3×3, …) in one click.
- **Drag-to-resize** — drag the divider between any two panes; terminals reflow
  automatically (and on window resize).
- **Multi-write / broadcast** — toggle Broadcast and your keystrokes go to every
  pane whose "write" box is checked. Type a command once, run it everywhere.
- **Robust lifecycle** — close a pane (the surviving sibling expands), processes
  that exit show a notice, and closing the last pane spawns a fresh one. All
  PTYs are killed when the window closes.
- **Workspace persistence** — the split layout, divider sizes, the shell chosen
  for each pane, pane titles and broadcast flags are saved automatically and
  restored on the next launch. The _layout_ is restored (each pane reopens with
  a fresh shell of the same type) — a PTY is a live process and can't be frozen
  and thawed, the same constraint tmux-resurrect works under.
- **AI coding agents in panes** — the **Agent** menu launches a coding-agent CLI
  (Claude Code, Codex, Gemini) in a new pane. Installed agents are auto-detected
  on `PATH`; missing ones are listed but greyed out. An agent pane carries its
  own identity (accent colour, ◆ marker) and a live **Working / Idle** badge so a
  grid of agents tells you at a glance which are busy and which are waiting on
  you. Agent panes persist and re-launch with the workspace.
- **Agent Task Board** — a built-in **kanban** side panel for tracking what each
  agent is working on. Toggle it with **`Ctrl+Shift+K`**. Add tasks, and move
  them across columns (e.g. _To Do → Doing → Done_) as the work progresses. The
  board lives alongside the panes so you can see the plan and the running agents
  at the same time, and its tasks are saved with the workspace so they survive a
  restart.

## Task Board

The **Task Board** turns the multi-agent grid into a small command centre:
plan the work in a kanban next to the terminals, then watch the agent panes
chew through it.

- **Toggle** the panel with **`Ctrl+Shift+K`** (it slides in beside the panes).
- **Add** a task by typing into the new-task box and pressing **Enter**.
- **Move** tasks across columns as they progress from queued to in-flight to
  done.
- **Persisted** — tasks are saved with the workspace (the same mechanism that
  restores your split layout) and restored on the next launch.

A puppeteer-core smoke test, `test-taskboard.cjs`, covers the core flow
end-to-end: it boots the renderer, toggles the board with `Ctrl+Shift+K`, adds
a task, and reloads to confirm the task persisted. Run it against the dev
server:

```sh
npm run dev          # in one terminal
node test-taskboard.cjs   # in another
```

## Run it

```sh
npm install
npm run dev      # development (hot reload)
# or
npm run build && npm start   # build, then run the production bundle
```

A window titled **Shell Panels** opens with one PowerShell pane.

## Keyboard shortcuts

| Shortcut       | Action            |
| -------------- | ----------------- |
| `Ctrl+Shift+E` | Split Right       |
| `Ctrl+Shift+O` | Split Down        |
| `Ctrl+Shift+W` | Close active pane |
| `Ctrl+Shift+B` | Toggle Broadcast  |
| `Ctrl+Shift+K` | Toggle Task Board |

## How it works

- **Main process** (`src/main/index.js`) owns the PTYs (one `node-pty` process
  per pane) and exposes a small IPC API: `pty:create / write / resize / kill`,
  plus `pty:data / pty:exit` events and `shells:list`.
- **Preload** (`src/preload/index.js`) bridges that API to the renderer over
  `contextBridge` — the renderer has no direct Node access.
- **Renderer** (Vue) renders a recursive binary split-tree (`SplitNode.vue`);
  each leaf is a `TerminalPane.vue` (an xterm.js terminal). Input is routed
  through `App.vue`, which sends it to one pane or broadcasts it to all.
- Output is buffered per-pane (`ptyStore.js`) so a terminal's history is
  replayed if a split re-parents it in the component tree — the underlying PTY
  is never killed by a layout change, only by an explicit close.

## Notes / decisions

- **ConPTY by default, WinPTY as a fallback.** ConPTY is the modern Windows
  console backend and is required for full-screen TUIs (e.g. Claude Code) to
  redraw correctly on resize the way they do in Windows Terminal, so it is the
  default. ConPTY's teardown is handled carefully — `terminatePty()` sends
  `Ctrl+C` + `exit` and falls back to a `taskkill` tree after a short delay so a
  pane never wedges the app. Set `SHELL_PANELS_USE_WINPTY=1` to force the older
  WinPTY backend if needed. See `src/main/index.js`.
- **`ELECTRON_RUN_AS_NODE`.** If this env var is set globally, Electron boots as
  plain Node and no window appears. `launch.mjs` strips it before launching, so
  `npm run dev` / `npm start` always open the GUI.
- **No native compiler needed.** node-pty ships a prebuilt N-API binary that
  loads under both Node and Electron, so no Visual Studio build tools are
  required to install.
- **Vite 8 with `legacy-peer-deps`.** The build runs Vite 8 deliberately: Vite 8
  dropped its direct `esbuild` dependency, which clears the esbuild dev-server
  advisories that Vite ≤7 still carries. `electron-vite` 5, however, caps its
  Vite peer range at `^7` (no release declares Vite 8 support yet), and npm 10
  treats that as a hard `ERESOLVE` error — so `.npmrc` sets
  `legacy-peer-deps=true` to let `npm install` resolve it. The combination is
  verified to work (build, the full test suite, and the app booting under
  Electron 42 all pass). Remove that flag once `electron-vite` ships Vite 8
  support. If a fresh `npm install` ever leaves the app failing to launch with
  `Error: Electron uninstall`, Electron's binary download was skipped — run
  `node node_modules/electron/install.js` to fetch it.
