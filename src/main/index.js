import { app, BrowserWindow, ipcMain, clipboard, dialog, Notification, shell } from 'electron'
import { join } from 'path'
import os from 'os'
import fs from 'fs'
import { spawn, execFile, execFileSync } from 'child_process'
import * as pty from 'node-pty'
import { loadTasks, saveTasks } from './taskBoardPersistence'
import { claudeSessionExists, findCodexSession, listSessions } from './agentSessions'
import { createLogger, describe } from './logger'
import {
  gitInfo,
  createWorktree,
  listMcp,
  addMcp,
  removeMcp,
  testMcp,
  copyMcp,
  hklFromTip
} from './agentTools'

// ---------------------------------------------------------------------------
// PTY registry
// ---------------------------------------------------------------------------
/** @type {Map<string, import('node-pty').IPty>} */
const ptys = new Map()
const ptyBackends = new Map()
// Pin the data folder (%APPDATA%\shell-panels) so the installed app and the
// dev build share saved workspaces, settings and tasks, whatever the product
// name the installer uses.
// SHELL_PANELS_USER_DATA overrides it (used for testing without touching your
// real workspaces).
app.setPath(
  'userData',
  process.env.SHELL_PANELS_USER_DATA || join(app.getPath('appData'), 'shell-panels')
)

let mainWindow = null

function appIconPath() {
  const ico = join(__dirname, '../../build/icon.ico')
  return fs.existsSync(ico) ? ico : join(__dirname, '../../build/icon.png')
}

// Our own taskbar identity. Without it, Windows groups the dev build under
// electron.exe and shows Electron's icon; with it, the taskbar uses ours. The
// installed app uses the installer's id so its Start menu shortcut, taskbar
// button and notifications line up.
const APP_ID = app.isPackaged
  ? 'com.jeanclaudetrottier.shellpanels'
  : 'com.jeanclaudetrottier.shellpanels.dev'
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

// Logs: %APPDATA%\\shell-panels\\logs\\shell-panels.log (rotated, 1 MB x 4).
const log = createLogger({ dir: join(app.getPath('userData'), 'logs') })

// Kept for older call sites: everything it reports is an error.
function logCrashContext(message) {
  log.error('main', message)
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

// Discover shells that actually exist on this machine.
function discoverShells() {
  const candidates = []
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const pf = process.env.ProgramFiles || 'C:\\Program Files'

  const list = [
    {
      id: 'powershell',
      name: 'Windows PowerShell',
      file: join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo']
    },
    {
      id: 'pwsh',
      name: 'PowerShell 7',
      file: join(pf, 'PowerShell', '7', 'pwsh.exe'),
      args: ['-NoLogo']
    },
    { id: 'cmd', name: 'Command Prompt', file: join(sysRoot, 'System32', 'cmd.exe'), args: [] },
    {
      id: 'gitbash',
      name: 'Git Bash',
      file: join(pf, 'Git', 'bin', 'bash.exe'),
      args: ['--login', '-i']
    },
    { id: 'wsl', name: 'WSL', file: join(sysRoot, 'System32', 'wsl.exe'), args: [] }
  ]

  for (const s of list) {
    try {
      if (fs.existsSync(s.file)) candidates.push(s)
    } catch {
      /* ignore */
    }
  }
  // Fallback: always offer cmd even if the probe failed.
  if (!candidates.length) {
    candidates.push({ id: 'cmd', name: 'Command Prompt', file: 'cmd.exe', args: [] })
  }
  return candidates
}

let shellCache = null
function getShells() {
  if (!shellCache) shellCache = discoverShells()
  return shellCache
}

// ---------------------------------------------------------------------------
// AI agent presets
// ---------------------------------------------------------------------------
// An "agent" is a CLI launched inside a normal shell pane (e.g. Claude Code).
// We detect which agent CLIs are actually on PATH so the UI can offer only the
// ones that will run, while still listing the rest as unavailable.
// Known agent CLIs. `install` lists the steps the Install button runs in a new
// pane when the agent isn't found on PATH (joined for the pane's shell).
const AGENT_PRESETS = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    accent: '#d97757',
    install: ['npm install -g @anthropic-ai/claude-code']
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    accent: '#10a37f',
    install: ['npm install -g @openai/codex']
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    accent: '#4285f4',
    install: ['npm install -g @google/gemini-cli']
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    accent: '#e8e8e8',
    install: ['npm install -g opencode-ai']
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    command: 'qwen',
    accent: '#7c5cff',
    install: ['npm install -g @qwen-code/qwen-code']
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    command: 'copilot',
    accent: '#8957e5',
    install: ['npm install -g @github/copilot']
  },
  {
    id: 'amp',
    name: 'Amp',
    command: 'amp',
    accent: '#f34e3f',
    install: ['npm install -g @sourcegraph/amp']
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    accent: '#14b014',
    install: ['python -m pip install aider-install', 'aider-install']
  }
]

// PATH as it is *now* in the registry (machine + user), not as it was when
// Shell Panels started. Installing an agent, or fixing PATH, then works in new
// panes without restarting the app.
let freshPath = null
function readFreshPath() {
  if (process.platform !== 'win32') return process.env.PATH
  try {
    const script =
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000
      }
    )
    const value = out.toString().trim()
    return value || null
  } catch {
    return null
  }
}

function currentPath() {
  if (freshPath === null) freshPath = readFreshPath() || ''
  return freshPath || process.env.PATH || process.env.Path || ''
}

// process.env with PATH replaced by the fresh value (Windows env keys are
// case-insensitive, so replace whichever spelling is present).
function freshEnv() {
  const env = { ...process.env }
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path'
  env[key] = currentPath()
  return env
}

function commandExists(bin) {
  if (!bin || !/^[\w.@+-]+$/.test(bin)) return false
  try {
    const out = execFileSync('where.exe', [bin], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: freshEnv()
    })
    return out.toString().trim().length > 0
  } catch {
    return false
  }
}

function firstWord(command) {
  return (
    String(command || '')
      .trim()
      .split(/\s+/)[0] || ''
  )
}

let agentCache = null
function getAgents(custom = []) {
  if (!agentCache) {
    agentCache = AGENT_PRESETS.map((a) => ({
      id: a.id,
      name: a.name,
      command: a.command,
      accent: a.accent,
      install: a.install,
      available: commandExists(a.command)
    }))
  }
  const extra = (Array.isArray(custom) ? custom : [])
    .filter((c) => c && c.id && c.name && c.command)
    .map((c) => ({
      id: String(c.id),
      name: String(c.name),
      command: String(c.command),
      accent: typeof c.accent === 'string' ? c.accent : '#8a93a6',
      custom: true,
      install: null,
      available: commandExists(firstWord(c.command))
    }))
  return [...agentCache, ...extra]
}

function defaultShell() {
  const shells = getShells()
  return shells.find((s) => s.id === 'powershell') || shells[0]
}

function shouldUseConpty() {
  return process.env.SHELL_PANELS_USE_WINPTY !== '1'
}

function windowsBuildNumber() {
  const parts = os.release().split('.')
  return parts[2] ? Number(parts[2]) : undefined
}

function taskkillTree(pid) {
  if (!pid) return
  const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  killer.on('error', () => {})
}

function terminatePty(id, child, forceDelay = 1500) {
  const backend = ptyBackends.get(id)
  if (backend === 'conpty') {
    try {
      child.write('\x03')
      child.write('exit\r')
    } catch {
      /* pty already gone */
    }
    const timer = setTimeout(() => {
      if (ptys.has(id)) taskkillTree(child.pid)
    }, forceDelay)
    timer.unref?.()
    return
  }
  try {
    child.kill()
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Workspace layout persistence
// ---------------------------------------------------------------------------
// The split-tree (structure, sizes, shell per pane, titles, broadcast flags) is
// saved to userData so the workspace reopens the way it was left. We persist the
// LAYOUT, not live process state: each pane is restored with a fresh PTY of the
// same shell (a PTY is a running process and cannot be serialized).
function layoutFile() {
  return join(app.getPath('userData'), 'workspace-layout.json')
}

ipcMain.handle('layout:load', () => {
  try {
    const p = layoutFile()
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    logCrashContext(`layout:load failed: ${err.message}`)
    return null
  }
})

ipcMain.on('layout:save', (_evt, data) => {
  try {
    fs.writeFileSync(layoutFile(), JSON.stringify(data, null, 2), 'utf8')
  } catch {
    /* best-effort: a failed save just means last layout is reused next launch */
  }
})

// ---------------------------------------------------------------------------
// Task-board persistence
// ---------------------------------------------------------------------------
// The kanban task board is stored in its own task-board.json (see
// taskBoardPersistence.js) so it never collides with workspace-layout.json.
ipcMain.handle('taskboard:load', () => {
  try {
    return loadTasks(app.getPath('userData'))
  } catch (err) {
    logCrashContext(`taskboard:load failed: ${err.message}`)
    return []
  }
})

ipcMain.handle('taskboard:save', (_evt, tasks) => {
  try {
    saveTasks(app.getPath('userData'), tasks)
    return { ok: true }
  } catch (err) {
    logCrashContext(`taskboard:save failed: ${err.message}`)
    return { ok: false, error: err.message }
  }
})

// ---------------------------------------------------------------------------
// IPC: terminal lifecycle
// ---------------------------------------------------------------------------
ipcMain.handle('shells:list', () => getShells())

// Folder picker for a workspace's project folder. Resolves to a path or null.
ipcMain.handle('dialog:pickFolder', async (_evt, opts = {}) => {
  if (!mainWindow) return null
  const res = await dialog.showOpenDialog(mainWindow, {
    title: opts.title || 'Choose a project folder',
    defaultPath: opts.defaultPath && fs.existsSync(opts.defaultPath) ? opts.defaultPath : undefined,
    properties: ['openDirectory', 'createDirectory']
  })
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
})

ipcMain.handle('app:homeDir', () => os.homedir())
// The language Windows itself is displayed in (e.g. fr-FR), used to pick a
// sensible default voice language. Not app.getSystemLocale(): that is the
// regional format (dates/numbers), which is often English even on a French
// Windows.
let windowsUiLanguage = null
ipcMain.handle('app:systemLocale', () => {
  if (windowsUiLanguage !== null) return windowsUiLanguage
  windowsUiLanguage = ''
  if (process.platform === 'win32') {
    try {
      windowsUiLanguage = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Globalization.CultureInfo]::CurrentUICulture.Name'
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }
      )
        .toString()
        .trim()
    } catch {
      windowsUiLanguage = ''
    }
  }
  if (!windowsUiLanguage) windowsUiLanguage = app.getLocale()
  log.info('voice', `windows display language: ${windowsUiLanguage}`)
  return windowsUiLanguage
})

// --- Logs ----------------------------------------------------------------------
// The interface reports its errors here (rate-limited, so a loop can't flood
// the disk).
let rendererLogBudget = { windowStart: Date.now(), count: 0 }
ipcMain.on('log:write', (_evt, entry = {}) => {
  const now = Date.now()
  if (now - rendererLogBudget.windowStart > 60000)
    rendererLogBudget = { windowStart: now, count: 0 }
  if (++rendererLogBudget.count > 60) return
  const level = ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info'
  log.write(level, 'ui', String(entry.message || '').slice(0, 6000))
})

ipcMain.handle('logs:open', () => shell.openPath(log.dir))

// Text to paste into a bug report: versions, system, and the recent log.
ipcMain.handle('logs:diagnostics', () => {
  const lines = [
    'Shell Panels diagnostics',
    `version: ${app.getVersion()} (${app.isPackaged ? 'installed' : 'dev'})`,
    `electron ${process.versions.electron}, chrome ${process.versions.chrome}, node ${process.versions.node}`,
    `os: ${process.platform} ${os.release()} ${os.arch()}, ${Math.round(os.totalmem() / 1073741824)} GB RAM`,
    `terminals open: ${ptys.size}`,
    `log file: ${log.file}`,
    '',
    '--- recent log ---',
    log.tail(20000)
  ]
  return lines.join('\n')
})

// Agent session lookups, for resuming conversations when panes reopen.
ipcMain.handle('sessions:claudeExists', (_evt, id) => claudeSessionExists(id))
ipcMain.handle('sessions:findCodex', (_evt, q = {}) => findCodexSession(q))
ipcMain.handle('sessions:list', (_evt, q = {}) => listSessions(q))

// Windows input languages, for choosing the voice typing language.
// Returns [{ tag: 'fr-CA', name: 'Français (Canada)', tip: '0C0C:00001009' }].
ipcMain.handle('app:inputLanguages', () => {
  if (process.platform !== 'win32') return []
  return new Promise((resolve) => {
    const script =
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $list = Get-WinUserLanguageList; ConvertTo-Json -Compress -InputObject @(foreach ($l in $list) { [pscustomobject]@{ tag = $l.LanguageTag; name = $l.LocalizedName; tip = @($l.InputMethodTips)[0] } })'
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve([])
        try {
          const data = JSON.parse(String(stdout).trim() || '[]')
          resolve((Array.isArray(data) ? data : [data]).filter((l) => l && l.tag))
        } catch {
          resolve([])
        }
      }
    )
  })
})

// Voice typing: optionally switch this window's input language (Windows
// dictation listens in the active input language; it does not auto-detect),
// then press Win+H, which opens Windows' built-in dictation for the focused
// terminal. Speech is handled by Windows; nothing is recorded by this app.
ipcMain.handle('app:voiceTyping', (_evt, opts = {}) => {
  if (process.platform !== 'win32') return false
  const hkl = hklFromTip(opts && opts.tip)
  log.info('voice', `start dictation, language ${opts && opts.tip ? opts.tip : 'keyboard default'}`)
  const hwnd = mainWindow ? mainWindow.getNativeWindowHandle().readBigUInt64LE(0) : 0n
  const lines = [
    'Add-Type -Namespace SP -Name Win -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra); [DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint msg, System.IntPtr w, System.IntPtr l);\''
  ]
  if (hkl && hwnd) {
    // WM_INPUTLANGCHANGEREQUEST
    lines.push(`[void][SP.Win]::PostMessage([IntPtr]${hwnd}, 0x50, [IntPtr]0, [IntPtr]${hkl})`)
    lines.push('Start-Sleep -Milliseconds 250')
  }
  lines.push(
    '[SP.Win]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)',
    '[SP.Win]::keybd_event(0x48, 0, 0, [UIntPtr]::Zero)',
    '[SP.Win]::keybd_event(0x48, 0, 2, [UIntPtr]::Zero)',
    '[SP.Win]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)'
  )
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', lines.join('; ')],
      { windowsHide: true, timeout: 15000 },
      (err) => resolve(!err)
    )
  })
})

// Links (sign-in pages, docs) open in the user's normal browser. Only web and
// mail links are allowed.
function isSafeExternal(url) {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}
ipcMain.handle('app:openExternal', async (_evt, url) => {
  if (!isSafeExternal(url)) return false
  await shell.openExternal(url)
  return true
})

// Multi-agent helpers: git worktrees and MCP server management.
const safe = (fn) => async (_evt, arg) => {
  try {
    return await fn(arg)
  } catch (err) {
    log.error('tools', err)
    return { ok: false, error: err.message }
  }
}
ipcMain.handle(
  'git:info',
  safe((cwd) => gitInfo(cwd))
)
ipcMain.handle(
  'git:createWorktree',
  safe(({ cwd, label } = {}) => createWorktree(cwd, label))
)
ipcMain.handle(
  'mcp:list',
  safe((cwd) => listMcp(cwd))
)
ipcMain.handle(
  'mcp:add',
  safe((spec) => addMcp(spec))
)
ipcMain.handle(
  'mcp:remove',
  safe((spec) => removeMcp(spec))
)
ipcMain.handle(
  'mcp:test',
  safe((ref) => testMcp(ref, freshEnv()))
)
ipcMain.handle(
  'mcp:copy',
  safe((spec) => copyMcp(spec))
)

// "An agent needs you": native notification + taskbar flash. Clicking the
// notification brings the window forward and tells the renderer which pane.
ipcMain.on('app:notify', (_evt, { title, body, paneId } = {}) => {
  if (!mainWindow) return
  if (!mainWindow.isFocused()) mainWindow.flashFrame(true)
  if (!Notification.isSupported()) return
  const n = new Notification({ title: title || 'Shell Panels', body: body || '', silent: false })
  n.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    send('app:focusPane', { paneId })
  })
  n.show()
})
ipcMain.handle('agents:list', (_evt, custom) => getAgents(custom))
// Which of these commands are on PATH (fresh PATH, so just-installed tools
// show up). Returns { bin: true|false }.
ipcMain.handle('tools:check', (_evt, bins) => {
  const out = {}
  for (const b of Array.isArray(bins) ? bins.slice(0, 50) : []) out[b] = commandExists(b)
  return out
})
// Full path of a command on the fresh PATH (null if missing).
function whichFresh(bin) {
  try {
    const out = execFileSync('where.exe', [bin], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: freshEnv()
    })
    return (
      out
        .toString()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean) || null
    )
  } catch {
    return null
  }
}

function runFile(file, args) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 20000, env: freshEnv() },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}\n${stderr || ''}` })
    )
  })
}

// Setup status for tools that need a one-time step, so Tools only offers the
// step when it's still needed: GitHub CLI sign-in and git's name/email.
ipcMain.handle('tools:status', async () => {
  const status = {}
  const gh = whichFresh('gh')
  if (gh) {
    const res = await runFile(gh, ['auth', 'status', '--hostname', 'github.com'])
    const m = /account\s+(\S+)/i.exec(res.out)
    status.gh = { signedIn: res.ok, account: res.ok && m ? m[1] : null }
  }
  const git = whichFresh('git')
  if (git) {
    const name = await runFile(git, ['config', '--global', 'user.name'])
    const email = await runFile(git, ['config', '--global', 'user.email'])
    const n = name.ok ? name.out.trim() : ''
    const e = email.ok ? email.out.trim() : ''
    status.git = { configured: !!(n && e), name: n || null, email: e || null }
  }
  return status
})

ipcMain.handle('tools:refreshPath', () => {
  freshPath = readFreshPath()
  agentCache = null
  return true
})

// Re-read PATH and re-detect agents (after installing one).
ipcMain.handle('agents:refresh', (_evt, custom) => {
  freshPath = readFreshPath()
  agentCache = null
  return getAgents(custom)
})

// Clipboard (kept in the main process so it works regardless of renderer
// focus/permission quirks).
ipcMain.handle('clipboard:read', () => clipboard.readText())
ipcMain.on('clipboard:write', (_evt, text) => {
  if (typeof text === 'string' && text.length) clipboard.writeText(text)
})

ipcMain.handle('pty:create', (_evt, opts = {}) => {
  const { id, shellId, cols = 80, rows = 24, cwd } = opts
  if (!id) throw new Error('pty:create requires an id')
  if (ptys.has(id)) throw new Error(`pty ${id} already exists`)

  const shell = getShells().find((s) => s.id === shellId) || defaultShell()
  const startDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir()

  let child
  const useConpty = shouldUseConpty()
  try {
    child = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: Math.max(2, cols | 0),
      rows: Math.max(1, rows | 0),
      cwd: startDir,
      env: freshEnv(),
      // ConPTY is the modern Windows terminal backend. It is required for
      // full-screen TUIs like Claude Code to redraw on resize like they do in
      // Windows Terminal. Set SHELL_PANELS_USE_WINPTY=1 only as a fallback.
      useConpty
    })
  } catch (err) {
    log.error(
      'pty',
      `failed to launch ${shell.name} (${shell.file}) in ${startDir}: ${err.message}`
    )
    return { ok: false, error: `Failed to launch ${shell.name}: ${err.message}` }
  }

  child.onData((data) => send('pty:data', { id, data }))
  child.onExit(({ exitCode, signal }) => {
    ptys.delete(id)
    ptyBackends.delete(id)
    if (exitCode)
      log.warn(
        'pty',
        `${shell.name} ${id} exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`
      )
    send('pty:exit', { id, exitCode, signal })
  })

  ptys.set(id, child)
  ptyBackends.set(id, useConpty ? 'conpty' : 'winpty')
  return {
    ok: true,
    shell: { id: shell.id, name: shell.name },
    backend: useConpty ? 'conpty' : 'winpty',
    windowsBuild: windowsBuildNumber(),
    pid: child.pid,
    cwd: startDir
  }
})

ipcMain.on('pty:write', (_evt, { id, data }) => {
  const child = ptys.get(id)
  if (child) {
    try {
      child.write(data)
    } catch {
      /* pty already gone */
    }
  }
})

ipcMain.on('pty:resize', (_evt, { id, cols, rows }) => {
  const child = ptys.get(id)
  if (child && cols > 0 && rows > 0) {
    try {
      child.resize(cols | 0, rows | 0)
    } catch {
      /* ignore resize race */
    }
  }
})

ipcMain.on('pty:kill', (_evt, { id }) => {
  const child = ptys.get(id)
  if (child) {
    terminatePty(id, child)
    ptys.delete(id)
    ptyBackends.delete(id)
  }
})

function killAll() {
  for (const [id, child] of ptys.entries()) {
    terminatePty(id, child, 300)
  }
  ptys.clear()
  ptyBackends.clear()
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#101216',
    title: 'Shell Panels',
    autoHideMenuBar: true,
    // Merge the title bar and our toolbar into one unified bar: hide the native
    // frame but overlay the Windows min/max/close buttons on top of our bar.
    // Taskbar/window icon. The installed app also gets it from the .exe; in dev
    // this replaces the default Electron icon.
    ...(fs.existsSync(appIconPath()) ? { icon: appIconPath() } : {}),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#101216',
      symbolColor: '#d6d9df',
      height: 39
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Dev build: point the taskbar button at our icon explicitly.
  if (process.platform === 'win32' && !app.isPackaged && fs.existsSync(appIconPath())) {
    mainWindow.setAppDetails({
      appId: APP_ID,
      appIconPath: appIconPath(),
      appIconIndex: 0,
      relaunchDisplayName: 'Shell Panels (dev)'
    })
  }
  // Never open pages inside the app window: send them to the system browser
  // (OAuth sign-in, e.g. Gemini or Claude, only works there).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL() && !url.startsWith('http://localhost:5173')) {
      event.preventDefault()
      if (isSafeExternal(url)) shell.openExternal(url)
    }
  })
  mainWindow.maximize()

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logCrashContext(`renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })

  mainWindow.webContents.on('responsive', () => log.info('window', 'responsive again'))
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) =>
    log.error('window', `failed to load ${url}: ${desc} (${code})`)
  )
  // A reload starts a fresh interface that spawns its own terminals: end the
  // old ones so they don't linger in the background.
  mainWindow.webContents.on('did-start-loading', () => {
    if (ptys.size) {
      log.warn(
        'window',
        `interface reloading; closing ${ptys.size} terminal(s) from the previous page`
      )
      killAll()
    }
  })
  mainWindow.webContents.on('unresponsive', () => {
    logCrashContext('renderer unresponsive')
  })

  mainWindow.on('focus', () => {
    if (mainWindow) mainWindow.flashFrame(false)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Windows takes a taskbar button's icon from the Start menu shortcut that owns
// the app's taskbar id. In dev, Electron creates one itself ("Electron.lnk",
// with Electron's icon) the first time a notification is shown, and then the
// taskbar shows Electron's logo whatever the window's icon is. So the dev
// build keeps its own shortcut with our icon, and removes Electron's only when
// it carries our id (other Electron apps are left alone).
function ensureDevShortcut() {
  if (process.platform !== 'win32' || app.isPackaged) return
  const icon = appIconPath()
  if (!fs.existsSync(icon)) return
  const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const ours = join(programs, 'Shell Panels (dev).lnk')
  const details = {
    target: process.execPath,
    args: `"${app.getAppPath()}"`,
    cwd: app.getAppPath(),
    icon,
    iconIndex: 0,
    appUserModelId: APP_ID,
    description: 'Shell Panels (development build)'
  }
  try {
    const op = fs.existsSync(ours) ? 'replace' : 'create'
    shell.writeShortcutLink(ours, op, details)
  } catch (err) {
    logCrashContext(`dev shortcut failed: ${err.message}`)
  }
  const electronLnk = join(programs, 'Electron.lnk')
  try {
    if (
      fs.existsSync(electronLnk) &&
      shell.readShortcutLink(electronLnk).appUserModelId === APP_ID
    ) {
      fs.unlinkSync(electronLnk)
    }
  } catch {
    /* not ours or unreadable: leave it */
  }
}

app.whenReady().then(() => {
  log.info(
    'app',
    `started v${app.getVersion()} (${app.isPackaged ? 'installed' : 'dev'}) electron ${process.versions.electron} node ${process.versions.node} ${process.platform} ${os.release()} ${os.arch()}`
  )
  ensureDevShortcut()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit')
    log.error(
      'app',
      `child process gone: ${details.type} ${details.reason} (exit ${details.exitCode})`
    )
})

app.on('before-quit', () => log.info('app', 'quitting'))

process.on('uncaughtException', (error) => {
  log.error('main', `uncaught exception: ${describe(error)}`)
})

process.on('unhandledRejection', (error) => {
  logCrashContext(`unhandledRejection: ${error && (error.stack || error.message || String(error))}`)
})

app.on('window-all-closed', () => {
  killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', killAll)
