import { writeJsonSafe } from './safeJson'
import { join } from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Task-board persistence
// ---------------------------------------------------------------------------
// The kanban task board is saved to userData as its own JSON file, kept fully
// separate from workspace-layout.json so the two features never clobber each
// other. We persist only the serializable task list (id, title, column,
// paneId) — the pane referenced by paneId is re-minted on restore, so dangling
// paneIds are reconciled at the App/integration layer, not here. This module is
// deliberately schema-agnostic: it round-trips whatever task array it is given,
// so it does not couple to the task model's exact field set.

export const TASK_BOARD_FILENAME = 'task-board.json'

/** Absolute path to the task-board file inside the given userData directory. */
export function taskBoardFilePath(userDataDir) {
  if (!userDataDir) throw new Error('taskBoardFilePath requires a userData directory')
  return join(userDataDir, TASK_BOARD_FILENAME)
}

/**
 * Load persisted tasks from the given userData directory.
 *
 * Returns [] when the file is absent or empty so the board always opens to a
 * valid state. Corrupt JSON throws on purpose: the caller (IPC handler) logs it
 * and falls back to [], keeping the failure visible rather than silent.
 *
 * @param {string} userDataDir
 * @returns {Array<object>}
 */
export function loadTasks(userDataDir) {
  const file = taskBoardFilePath(userDataDir)
  if (!fs.existsSync(file)) return backupTasks(file) || []

  const raw = fs.readFileSync(file, 'utf8')
  // Empty or damaged (the app was stopped mid-write by an older version):
  // the previous good copy, if any.
  if (!raw.trim()) return backupTasks(file) || []

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const bak = backupTasks(file)
    if (bak) {
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`)
      } catch {
        // keeping the damaged copy is best effort
      }
      return bak
    }
    throw err
  }
  if (Array.isArray(parsed)) return parsed
  // Forward-compatible: also accept a { version, tasks: [...] } envelope.
  if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks
  return []
}

// The previous good copy (<file>.bak), or null.
function backupTasks(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))
    if (Array.isArray(parsed)) return parsed
    if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks
  } catch {
    // no usable backup
  }
  return null
}

/**
 * Persist the task list as pretty-printed JSON. Throws on non-array input so a
 * malformed save surfaces instead of silently dropping the board.
 *
 * @param {string} userDataDir
 * @param {Array<object>} tasks
 * @returns {string} the path written
 */
export function saveTasks(userDataDir, tasks) {
  if (!Array.isArray(tasks)) throw new Error('saveTasks requires an array of tasks')
  const file = taskBoardFilePath(userDataDir)
  // Temp file + rename, previous copy kept as .bak: a kill mid-write never
  // leaves an empty or cut board.
  writeJsonSafe(file, tasks)
  return file
}
