// The task board, for the agents of a team (through the team tools,
// teamMcp/server.cjs):
//   <project>/.tessel/team-channel/<team>/tasks.json   the team's cards, written
//     by Tessel (the only writer of the board) for the agents to read
//   <project>/.tessel/team-channel/<team>/requests/<paneId>__<random>.json
//     an agent asks Tessel to add or move a card; Tessel takes each request
//     in, applies it on the board and deletes the file
import fs from 'fs'
import { join, resolve, isAbsolute } from 'path'

const ID_RE = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/
export const TASK_COLUMNS = ['todo', 'doing', 'review', 'done']
const MAX_TITLE = 200
const MAX_REQUESTS = 50 // per round

function teamRoot(dir, teamId) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || typeof teamId !== 'string' || !ID_RE.test(teamId)) return null
  return join(resolve(dir), '.tessel', 'team-channel', teamId)
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

// tasks: [{ id, title, column, assignee ("#1" or null), since }]
export function publishTeamTasks({ dir, teamId, tasks } = {}) {
  const root = teamRoot(dir, teamId)
  if (!root || !Array.isArray(tasks)) return { ok: false, error: 'Invalid team location.' }
  if (!fs.existsSync(root)) return { ok: true, changed: false }
  const clean = tasks
    .filter((t) => t && ID_RE.test(String(t.id)) && typeof t.title === 'string' && TASK_COLUMNS.includes(t.column))
    .map((t) => ({
      id: t.id,
      title: t.title.slice(0, MAX_TITLE),
      column: t.column,
      assignee: typeof t.assignee === 'string' && /^#\d{1,3}$/.test(t.assignee) ? t.assignee : null,
      since: Number.isFinite(t.since) ? t.since : null
    }))
  const file = join(root, 'tasks.json')
  let old = null
  try {
    old = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    old = null
  }
  if (old && JSON.stringify(old.tasks) === JSON.stringify(clean)) return { ok: true, changed: false }
  writeAtomic(file, { version: 1, tasks: clean })
  return { ok: true, changed: true }
}

// Validated requests, oldest first; their files are removed.
// -> { ok, requests: [{ fromId, action: 'add', title, assignee, column }
//                      | { fromId, action: 'move', id, column }] ,
//      refused: [{ fromId, error }] }
export function takeTeamRequests({ dir, teamId } = {}) {
  const root = teamRoot(dir, teamId)
  if (!root) return { ok: false, error: 'Invalid team location.' }
  const folder = join(root, 'requests')
  if (!fs.existsSync(folder)) return { ok: true, requests: [], refused: [] }
  const files = []
  for (const name of fs.readdirSync(folder)) {
    const m = /^([A-Za-z0-9._-]{1,100})__[A-Za-z0-9-]{1,80}\.json$/.exec(name)
    if (!m) continue
    let at = 0
    try {
      at = fs.statSync(join(folder, name)).mtimeMs
    } catch {
      continue
    }
    files.push({ name, fromId: m[1], at })
  }
  files.sort((a, b) => a.at - b.at)
  const requests = []
  const refused = []
  for (const f of files.slice(0, MAX_REQUESTS)) {
    const file = join(folder, f.name)
    let data = null
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue // being written: next round
    }
    try {
      fs.rmSync(file, { force: true })
    } catch {
      continue // taken next round
    }
    const req = parseRequest(data)
    if (req.error) refused.push({ fromId: f.fromId, error: req.error })
    else requests.push({ fromId: f.fromId, ...req })
  }
  return { ok: true, requests, refused }
}

export function parseRequest(data) {
  if (!data || typeof data !== 'object') return { error: 'the request is not readable' }
  const column = data.column == null ? null : String(data.column).toLowerCase()
  if (column !== null && !TASK_COLUMNS.includes(column))
    return { error: `unknown column "${data.column}" (use ${TASK_COLUMNS.join(', ')})` }
  if (data.action === 'add') {
    const title = typeof data.title === 'string' ? data.title.replace(/\s+/g, ' ').trim() : ''
    if (!title) return { error: 'a card needs a title' }
    if (title.length > MAX_TITLE) return { error: `the title is too long (at most ${MAX_TITLE} characters)` }
    const assignee = data.assignee == null || data.assignee === '' ? null : String(data.assignee).trim()
    if (assignee !== null && !/^#\d{1,3}$/.test(assignee)) return { error: '"assignee" must be a teammate like "#3"' }
    return { action: 'add', title, assignee, column: column || 'todo' }
  }
  if (data.action === 'move') {
    if (typeof data.id !== 'string' || !ID_RE.test(data.id)) return { error: 'the card id is not valid' }
    if (!column) return { error: 'say which column to move it to' }
    return { action: 'move', id: data.id, column }
  }
  return { error: 'unknown request' }
}
