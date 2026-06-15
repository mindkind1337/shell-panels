// Shared task model for the in-app Agent Task Board (kanban). Pure ESM — no Vue
// and no DOM — so the renderer store, tests, and any main-process persistence
// code can all import the same shape and column definition.

export const COLUMNS = ['todo', 'doing', 'review', 'done']

let counter = 0
function newId() {
  counter += 1
  return `task-${counter}-${Math.floor(Math.random() * 1e6)}`
}

// Build a fresh task. Starts in the first column, unassigned to any pane.
export function createTask({ title } = {}) {
  const name = typeof title === 'string' ? title.trim() : ''
  if (!name) throw new Error('createTask requires a non-empty title')
  return {
    id: newId(),
    title: name,
    column: COLUMNS[0],
    paneId: null
  }
}
