import { contextBridge, ipcRenderer } from 'electron'

// Bridge a minimal, typed-ish API to the renderer. No node access leaks.
const api = {
  listShells: () => ipcRenderer.invoke('shells:list'),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  writePty: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.send('pty:kill', { id }),

  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),

  // Workspace layout persistence.
  loadLayout: () => ipcRenderer.invoke('layout:load'),
  saveLayout: (data) => ipcRenderer.send('layout:save', data),

  // Task-board persistence. load() resolves to the saved task array ([] when
  // none); save(tasks) resolves to { ok: true } or { ok: false, error }.
  taskBoard: {
    load: () => ipcRenderer.invoke('taskboard:load'),
    save: (tasks) => ipcRenderer.invoke('taskboard:save', tasks)
  },

  // Subscriptions return an unsubscribe function.
  onData: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },
  onExit: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('pty:exit', handler)
    return () => ipcRenderer.removeListener('pty:exit', handler)
  }
}

contextBridge.exposeInMainWorld('shellApi', api)
