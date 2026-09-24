// Launcher that guarantees a GUI: some environments set ELECTRON_RUN_AS_NODE=1
// globally, which makes Electron boot as plain Node (no window). We strip it
// before spawning electron-vite so the app always launches as a desktop app.
import { spawn } from 'child_process'

const mode = process.argv[2] || 'dev'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// In dev, --watch restarts the app when main-process or preload code changes,
// so background changes take effect without closing the window by hand.
const args = mode === 'dev' ? [mode, '--watch'] : [mode]

const child = spawn('electron-vite', args, {
  stdio: 'inherit',
  env,
  shell: true
})
child.on('exit', (code) => process.exit(code ?? 0))
