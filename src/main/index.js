import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { join } from 'path'
import os from 'os'
import fs from 'fs'
import { spawn, execFileSync } from 'child_process'
import * as pty from 'node-pty'
import { loadTasks, saveTasks } from './taskBoardPersistence'

// ---------------------------------------------------------------------------
// PTY registry
// ---------------------------------------------------------------------------
/** @type {Map<string, import('node-pty').IPty>} */
const ptys = new Map()
const ptyBackends = new Map()
let mainWindow = null

function logCrashContext(message) {
  try {
    fs.appendFileSync(join(process.cwd(), 'shell-panels-crash.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* logging is best-effort */
  }
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
const AGENT_PRESETS = [
  { id: 'claude', name: 'Claude Code', command: 'claude', accent: '#d97757', bin: 'claude' },
  { id: 'codex', name: 'Codex CLI', command: 'codex', accent: '#10a37f', bin: 'codex' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', accent: '#4285f4', bin: 'gemini' }
]

function commandExists(bin) {
  try {
    const out = execFileSync('where.exe', [bin], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.toString().trim().length > 0
  } catch {
    return false
  }
}

let agentCache = null
function getAgents() {
  if (!agentCache) {
    agentCache = AGENT_PRESETS.map((a) => ({
      id: a.id,
      name: a.name,
      command: a.command,
      accent: a.accent,
      available: commandExists(a.bin)
    }))
  }
  return agentCache
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
ipcMain.handle('agents:list', () => getAgents())

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
      env: { ...process.env },
      // ConPTY is the modern Windows terminal backend. It is required for
      // full-screen TUIs like Claude Code to redraw on resize like they do in
      // Windows Terminal. Set SHELL_PANELS_USE_WINPTY=1 only as a fallback.
      useConpty
    })
  } catch (err) {
    return { ok: false, error: `Failed to launch ${shell.name}: ${err.message}` }
  }

  child.onData((data) => send('pty:data', { id, data }))
  child.onExit(({ exitCode, signal }) => {
    ptys.delete(id)
    ptyBackends.delete(id)
    send('pty:exit', { id, exitCode, signal })
  })

  ptys.set(id, child)
  ptyBackends.set(id, useConpty ? 'conpty' : 'winpty')
  return {
    ok: true,
    shell: { id: shell.id, name: shell.name },
    backend: useConpty ? 'conpty' : 'winpty',
    windowsBuild: windowsBuildNumber(),
    pid: child.pid
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
    backgroundColor: '#1e1e1e',
    title: 'Shell Panels',
    autoHideMenuBar: true,
    // Merge the title bar and our toolbar into one unified bar: hide the native
    // frame but overlay the Windows min/max/close buttons on top of our bar.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#242424',
      symbolColor: '#d4d4d4',
      height: 33
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
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

  mainWindow.webContents.on('unresponsive', () => {
    logCrashContext('renderer unresponsive')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

process.on('uncaughtException', (error) => {
  logCrashContext(`uncaughtException: ${error.stack || error.message}`)
})

process.on('unhandledRejection', (error) => {
  logCrashContext(`unhandledRejection: ${error && (error.stack || error.message || String(error))}`)
})

app.on('window-all-closed', () => {
  killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', killAll)
