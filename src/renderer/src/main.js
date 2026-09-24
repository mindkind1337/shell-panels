import { createApp } from 'vue'
import App from './App.vue'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import { startCapture } from './ptyStore'

// Begin buffering PTY output before any pane mounts so nothing is lost.
startCapture()

// Send interface errors to the app log (%APPDATA%\\shell-panels\\logs).
function report(level, value) {
  try {
    const text =
      value && value.stack ? value.stack : typeof value === 'string' ? value : JSON.stringify(value)
    if (window.shellApi && window.shellApi.log) window.shellApi.log(level, text)
  } catch {
    /* logging must never throw */
  }
}
window.addEventListener('error', (e) =>
  report('error', e.error || `${e.message} at ${e.filename}:${e.lineno}`)
)
window.addEventListener('unhandledrejection', (e) =>
  report('error', e.reason || 'unhandled promise rejection')
)
const origError = console.error.bind(console)
console.error = (...args) => {
  report('error', args.map((a) => (a && a.stack ? a.stack : String(a))).join(' '))
  origError(...args)
}

// If the interface ever fails to start or crashes, show what happened and a
// Reload button instead of leaving a blank black window.
let shown = false
function showCrash(err) {
  console.error(err)
  if (shown) return
  shown = true
  const box = document.createElement('div')
  box.className = 'crash-screen'
  const title = document.createElement('h1')
  title.textContent = 'Shell Panels hit a problem'
  const text = document.createElement('p')
  text.textContent =
    'The window could not finish loading. Your workspaces are saved. Reload to try again.'
  const detail = document.createElement('pre')
  detail.textContent = String((err && (err.stack || err.message)) || err).slice(0, 1200)
  const button = document.createElement('button')
  button.textContent = 'Reload'
  button.onclick = () => window.location.reload()
  const logs = document.createElement('button')
  logs.textContent = 'Open logs folder'
  logs.className = 'secondary'
  logs.onclick = () => window.shellApi && window.shellApi.openLogs && window.shellApi.openLogs()
  const row = document.createElement('div')
  row.className = 'crash-actions'
  row.append(button, logs)
  box.append(title, text, row, detail)
  document.body.appendChild(box)
}

const app = createApp(App)
app.config.errorHandler = (err, _instance, info) => {
  report('error', `${info}: ${err && err.stack ? err.stack : err}`)
  // Errors during setup/render leave the screen empty; everything else is logged.
  if (/setup|render|mounted/i.test(String(info))) showCrash(err)
  else console.error(err)
}
window.addEventListener('error', (e) => {
  if (!document.querySelector('.app')) showCrash(e.error || e.message)
})

try {
  app.mount('#app')
} catch (err) {
  showCrash(err)
}
