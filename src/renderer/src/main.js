import { createApp } from 'vue'
import App from './App.vue'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import { startCapture } from './ptyStore'

// Begin buffering PTY output before any pane mounts so nothing is lost.
startCapture()

createApp(App).mount('#app')
