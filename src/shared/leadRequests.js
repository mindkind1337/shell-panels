// A team lead (an agent) asks Tessel to act by writing small JSON files into
// its own inbox folder. Only four requests exist, and none can merge, discard
// or close anything: those stay the user's.
//
//   { "action": "task", "title": "...", "brief": "...", "agent": "#3" | "codex", "own_copy": true }
//   { "action": "message", "to": "#3" | "team", "text": "..." }
//   { "action": "approve", "task": "<title>", "note": "..." }
//   { "action": "changes", "task": "<title>", "text": "..." }
//
// parseLeadRequest(json) -> { ok: true, ...normalized } | { ok: false, error }.

const MAX_TITLE = 120
const MAX_TEXT = 6000

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

// "#3", "3" or 3 -> 3; anything else -> null.
function paneNum(v) {
  const m = /^#?(\d{1,3})$/.exec(String(v == null ? '' : v).trim())
  return m ? Number(m[1]) : null
}

export function parseLeadRequest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'not a JSON object' }
  const action = str(data.action, 20).toLowerCase()
  if (action === 'task') {
    const title = str(data.title, MAX_TITLE)
    if (!title) return { ok: false, error: 'a task needs a "title"' }
    const agent = str(String(data.agent == null ? '' : data.agent), 40)
    const num = paneNum(agent)
    const kind = num == null && /^[a-z0-9_-]{1,40}$/i.test(agent) ? agent.toLowerCase() : null
    if (num == null && !kind) return { ok: false, error: 'a task needs an "agent": a teammate like "#3", or an agent kind like "codex"' }
    return {
      ok: true,
      action,
      title,
      brief: str(data.brief, MAX_TEXT),
      num,
      kind,
      ownCopy: data.own_copy !== false
    }
  }
  if (action === 'message') {
    const text = str(data.text, MAX_TEXT)
    if (!text) return { ok: false, error: 'a message needs a "text"' }
    const to = String(data.to == null ? '' : data.to).trim().toLowerCase()
    if (to === 'team' || to === 'all') return { ok: true, action, to: 'team', num: null, text }
    const num = paneNum(to)
    if (num == null) return { ok: false, error: 'a message needs "to": "#3" or "team"' }
    return { ok: true, action, to: 'one', num, text }
  }
  if (action === 'approve' || action === 'changes') {
    const task = str(data.task, MAX_TITLE)
    if (!task) return { ok: false, error: `"${action}" needs the "task" title` }
    const text = str(action === 'approve' ? data.note : data.text, MAX_TEXT)
    if (action === 'changes' && !text) return { ok: false, error: '"changes" needs a "text" saying what to change' }
    return { ok: true, action, task, text }
  }
  return { ok: false, error: `unknown action "${action || '(none)'}": use task, message, approve or changes` }
}

// Find a task by the title the lead wrote (exact, then case-insensitive,
// then a unique prefix).
export function findTaskByTitle(tasks, title) {
  const t = String(title || '').trim()
  const low = t.toLowerCase()
  return (
    tasks.find((x) => x.title === t) ||
    tasks.find((x) => x.title.toLowerCase() === low) ||
    (() => {
      const hits = tasks.filter((x) => x.title.toLowerCase().startsWith(low))
      return hits.length === 1 ? hits[0] : null
    })()
  )
}

// What the lead is told when it takes the role (also written as HOW-TO.md in
// its inbox).
export function leadGuide({ teamName, inbox, members, kinds }) {
  return [
    `You now lead the team "${teamName}". Your teammates: ${members.length ? members.join(', ') : 'none yet'}.`,
    'Your job: split the goal into small tasks, give each to a teammate (or start a new agent), review what they finish, and tell the user when work is ready. You do not merge, discard or close anything: the user does that.',
    `To act, write one JSON file per request into ${inbox} (any name ending in .json). Tessel reads it within a few seconds, deletes it, and answers here with [Tessel] lines.`,
    '- Give a task: {"action":"task","title":"Short title","brief":"What to do, which files, how to check it","agent":"#3"}. "agent" is a teammate number, or ' +
      (kinds.length ? kinds.map((k) => `"${k}"`).join(', ') : 'an agent kind') +
      ' to start a new agent. New agents work in their own copy (git branch); add "own_copy": false to work in the project folder.',
    '- Message: {"action":"message","to":"#3","text":"..."} or "to":"team".',
    '- After a teammate finishes, you get a review request. Then either {"action":"approve","task":"Short title","note":"why it is good"} (the user is told it is ready to merge) or {"action":"changes","task":"Short title","text":"what to fix"} (it goes back to the teammate).',
    'Keep tasks independent so teammates do not edit the same files at once.'
  ].join('\n')
}
