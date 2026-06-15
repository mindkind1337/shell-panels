// Captures all PTY output into per-id ring buffers so a TerminalPane can replay
// its history when it is (re)mounted — e.g. after a split re-parents it in the
// component tree. The PTY itself lives in the main process and is never killed
// on unmount, so the session survives layout changes.

const buffers = new Map() // id -> string
const MAX = 200_000 // ~200 KB of recent output kept per pane
let started = false

export function startCapture() {
  if (started || !window.shellApi) return
  started = true
  window.shellApi.onData(({ id, data }) => {
    const prev = buffers.get(id) || ''
    let next = prev + data
    if (next.length > MAX) next = next.slice(next.length - MAX)
    buffers.set(id, next)
  })
}

export function getBuffer(id) {
  return buffers.get(id) || ''
}

export function dropBuffer(id) {
  buffers.delete(id)
}
