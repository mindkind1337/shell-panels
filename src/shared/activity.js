// Activity of agents: what Tessel records and the numbers it shows.
//
// Pure ESM, no Vue, no DOM: the renderer records events, the main process
// stores them, tests check the maths. The model follows agent-observability
// tools (OpenTelemetry GenAI, Langfuse): point-in-time *events* (a message,
// a team change) and *spans* derived from state changes (an agent working,
// waiting for your approval, out of usage...).
//
// An event: { t, type, paneId?, agent?: { title, agentId }, ...fields }
//   agent.state      state: 'working' | 'idle' | 'approval' | 'limited' | 'closed'
//   message          status: 'sent' | 'held' | 'delivered' | 'skipped'
//                    source: 'you' | 'tessel'; scope: 'team' | 'workspace' | 'notes'
//                    | 'team-change' | 'task'; teamId?, wsId?, preview
//   team             action: 'created' | 'renamed' | 'left' | 'closed' | 'ungrouped'
//                    teamId, name, detail?

export const MAX_EVENTS = 20000
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000

// Keep the log bounded: at most MAX_EVENTS, none older than MAX_AGE_MS.
export function trimEvents(events, now = Date.now()) {
  const fresh = events.filter((e) => e && Number.isFinite(e.t) && now - e.t <= MAX_AGE_MS)
  return fresh.length > MAX_EVENTS ? fresh.slice(fresh.length - MAX_EVENTS) : fresh
}

export function isEvent(e) {
  return !!e && typeof e === 'object' && Number.isFinite(e.t) && typeof e.type === 'string'
}

function median(list) {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

// Journal lines of the shared notes: "- 2026-09-24 Codex: text".
export function parseJournal(text) {
  const out = []
  const lines = String(text || '').split(/\r?\n/)
  let inJournal = false
  for (const line of lines) {
    if (/^##\s+Journal\b/i.test(line)) {
      inJournal = true
      continue
    }
    if (/^##\s/.test(line)) {
      inJournal = false
      continue
    }
    if (!inJournal) continue
    const m = /^-\s+(\d{4}-\d{2}-\d{2})\s+([^:()]+?)(?:\s*\([^)]*\))?:\s*(.*)$/.exec(line)
    if (m) out.push({ date: m[1], author: m[2].trim(), text: m[3].trim() })
  }
  return out
}

// Does a journal author ("Codex", "Claude") stand for this agent?
export function authorMatches(author, agent) {
  const a = String(author || '').toLowerCase()
  if (!a || !agent) return false
  const id = String(agent.agentId || '').toLowerCase()
  const title = String(agent.title || '').toLowerCase()
  return (!!id && a.includes(id)) || (!!title && (title.includes(a) || a.includes(title)))
}

// Everything the Activity view shows, for one scope and period.
//   events   the log (any order)
//   opts     { now, from, paneIds: Set | null (null = every pane),
//              live: { [paneId]: { state, title, agentId } } for panes open now,
//              journal: parseJournal() entries }
export function summarize(events, opts = {}) {
  const now = opts.now ?? Date.now()
  const from = opts.from ?? now - 7 * 24 * 3600 * 1000
  const inScope = (id) => !opts.paneIds || opts.paneIds.has(id)
  const sorted = events.filter(isEvent).sort((a, b) => a.t - b.t)

  const agents = new Map() // paneId -> row
  const row = (id, agent) => {
    let r = agents.get(id)
    if (!r) {
      r = {
        paneId: id,
        title: 'Agent',
        agentId: null,
        open: false,
        state: 'closed',
        since: null,
        ms: { working: 0, idle: 0, approval: 0, limited: 0 },
        approvals: 0,
        limits: 0,
        received: 0,
        held: 0,
        skipped: 0,
        journal: 0,
        lastActivity: null
      }
      agents.set(id, r)
    }
    if (agent) {
      r.title = agent.title || r.title
      r.agentId = agent.agentId || r.agentId
    }
    return r
  }

  const waits = [] // approval waits that ended in the period (ms)
  const timeline = []
  const current = new Map() // paneId -> { state, since }

  const addSpan = (id, state, start, end) => {
    const a = Math.max(start, from)
    const b = Math.min(end, now)
    if (b > a && row(id).ms[state] !== undefined) row(id).ms[state] += b - a
  }

  for (const e of sorted) {
    const id = e.paneId
    if (id && !inScope(id)) continue
    if (e.t > now) continue
    if (e.type === 'agent.state' && id) {
      const r = row(id, e.agent)
      const prev = current.get(id)
      if (prev) {
        addSpan(id, prev.state, prev.since, e.t)
        if (prev.state === 'approval' && e.state !== 'approval' && e.t >= from) {
          waits.push(e.t - prev.since)
          timeline.push({ t: e.t, kind: 'approval-end', paneId: id, title: r.title, agentId: r.agentId, waited: e.t - prev.since })
        }
        if (prev.state === 'limited' && e.state !== 'limited' && e.t >= from) {
          timeline.push({ t: e.t, kind: 'limit-end', paneId: id, title: r.title, agentId: r.agentId })
        }
      }
      if (e.t >= from && e.state === 'approval' && prev?.state !== 'approval') {
        r.approvals++
        timeline.push({ t: e.t, kind: 'approval', paneId: id, title: r.title, agentId: r.agentId })
      }
      if (e.t >= from && e.state === 'limited' && prev?.state !== 'limited') {
        r.limits++
        timeline.push({ t: e.t, kind: 'limit', paneId: id, title: r.title, agentId: r.agentId, reset: e.reset || '' })
      }
      if (!prev || prev.state !== e.state) current.set(id, { state: e.state, since: e.t })
      if (e.t >= from && (e.state === 'working' || e.state === 'approval')) r.lastActivity = e.t
      continue
    }
    if (e.type === 'message' && id) {
      const r = row(id, e.agent)
      if (e.t < from) continue
      if (e.status === 'sent' || e.status === 'delivered') r.received++
      if (e.status === 'held') r.held++
      if (e.status === 'skipped') r.skipped++
      r.lastActivity = Math.max(r.lastActivity || 0, e.t)
      if (e.status !== 'delivered') {
        timeline.push({
          t: e.t,
          kind: 'message',
          paneId: id,
          title: r.title,
          agentId: r.agentId,
          status: e.status,
          source: e.source || 'you',
          scope: e.scope || 'workspace',
          preview: e.preview || ''
        })
      }
      continue
    }
    if (e.type === 'team' && e.t >= from) {
      if (opts.teamId && e.teamId !== opts.teamId) continue
      timeline.push({ t: e.t, kind: 'team', action: e.action, name: e.name, detail: e.detail || '' })
    }
  }

  // Open spans run until now.
  const live = opts.live || {}
  for (const [id, cur] of current) {
    const r = row(id)
    const isOpen = !!live[id]
    if (isOpen || cur.state !== 'closed') {
      if (isOpen) addSpan(id, cur.state, cur.since, now)
    }
    r.state = isOpen ? live[id].state || cur.state : 'closed'
    r.since = isOpen && (live[id].state || cur.state) === cur.state ? cur.since : null
  }
  for (const [id, info] of Object.entries(live)) {
    if (!inScope(id)) continue
    const r = row(id, info)
    r.open = true
    if (!current.has(id)) {
      r.state = info.state || 'idle'
      r.since = null
    }
  }

  // Journal entries of the shared notes, by author.
  const journal = (opts.journal || []).filter((j) => Date.parse(j.date + 'T23:59:59') >= from)
  for (const j of journal) {
    for (const r of agents.values()) if (authorMatches(j.author, r)) r.journal++
    timeline.push({ t: Date.parse(j.date + 'T12:00:00'), day: j.date, kind: 'journal', author: j.author, preview: j.text })
  }

  const rows = [...agents.values()].sort(
    (a, b) => Number(b.open) - Number(a.open) || (b.lastActivity || 0) - (a.lastActivity || 0)
  )
  const open = rows.filter((r) => r.open)
  const messages = rows.reduce(
    (acc, r) => ({ received: acc.received + r.received, held: acc.held + r.held, skipped: acc.skipped + r.skipped }),
    { received: 0, held: 0, skipped: 0 }
  )
  return {
    from,
    now,
    cards: {
      needsApproval: open.filter((r) => r.state === 'approval').length,
      working: open.filter((r) => r.state === 'working').length,
      openAgents: open.length,
      approvalWait: { median: median(waits), count: waits.length },
      messages
    },
    rows,
    timeline: timeline.sort((a, b) => b.t - a.t).slice(0, 300),
    empty: !rows.length && !timeline.length
  }
}

// "4 min", "2 h 05", "3 d 4 h": short durations for the table.
export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')}`
  const d = Math.floor(h / 24)
  return `${d} d ${h % 24} h`
}
