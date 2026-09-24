import { describe, it, expect } from 'vitest'
import {
  summarize,
  parseJournal,
  authorMatches,
  trimEvents,
  formatDuration,
  MAX_EVENTS
} from '../../../shared/activity'

const MIN = 60 * 1000
const T0 = Date.parse('2026-09-24T12:00:00Z')
const claude = { title: 'Claude Code', agentId: 'claude' }
const codex = { title: 'Codex CLI', agentId: 'codex' }
const st = (min, paneId, state, agent, extra = {}) => ({
  t: T0 + min * MIN,
  type: 'agent.state',
  paneId,
  state,
  agent,
  ...extra
})

describe('summarize', () => {
  const events = [
    st(0, 'p1', 'working', claude),
    st(10, 'p1', 'idle', claude),
    st(0, 'p2', 'working', codex),
    st(5, 'p2', 'approval', codex),
    st(9, 'p2', 'working', codex),
    st(20, 'p2', 'limited', codex, { reset: '8:47 PM' }),
    { t: T0 + 12 * MIN, type: 'message', paneId: 'p1', agent: claude, status: 'sent', source: 'you', scope: 'team', preview: 'hi' },
    { t: T0 + 12 * MIN, type: 'message', paneId: 'p2', agent: codex, status: 'held', source: 'you', scope: 'team', preview: 'hi' },
    { t: T0 + 13 * MIN, type: 'message', paneId: 'p2', agent: codex, status: 'delivered', source: 'you', scope: 'team', preview: 'hi' },
    { t: T0 + 25 * MIN, type: 'message', paneId: 'p2', agent: codex, status: 'skipped', source: 'tessel', scope: 'team-change', preview: 'x' },
    { t: T0 + 1 * MIN, type: 'team', action: 'created', teamId: 't1', name: 'Team 1' }
  ]
  const live = { p1: { state: 'idle', ...claude }, p2: { state: 'limited', ...codex } }
  const s = summarize(events, { now: T0 + 30 * MIN, from: T0 - 60 * MIN, live })

  it('adds up time in each state, open spans running until now', () => {
    const p1 = s.rows.find((r) => r.paneId === 'p1')
    expect(p1.ms.working).toBe(10 * MIN)
    expect(p1.ms.idle).toBe(20 * MIN)
    const p2 = s.rows.find((r) => r.paneId === 'p2')
    expect(p2.ms.working).toBe(5 * MIN + 11 * MIN)
    expect(p2.ms.approval).toBe(4 * MIN)
    expect(p2.ms.limited).toBe(10 * MIN)
  })

  it('counts approvals, limits and messages per agent', () => {
    const p2 = s.rows.find((r) => r.paneId === 'p2')
    expect(p2.approvals).toBe(1)
    expect(p2.limits).toBe(1)
    expect(p2.received).toBe(1) // held then delivered counts once as received
    expect(p2.held).toBe(1)
    expect(p2.skipped).toBe(1)
    expect(s.cards.messages).toEqual({ received: 2, held: 1, skipped: 1 })
  })

  it('reports the approval wait and what is going on now', () => {
    expect(s.cards.approvalWait).toEqual({ median: 4 * MIN, count: 1 })
    expect(s.cards.working).toBe(0)
    expect(s.cards.openAgents).toBe(2)
    const p2 = s.rows.find((r) => r.paneId === 'p2')
    expect(p2.state).toBe('limited')
    expect(p2.since).toBe(T0 + 20 * MIN)
  })

  it('builds a newest-first timeline without the working/idle churn', () => {
    const kinds = s.timeline.map((x) => x.kind)
    expect(kinds[0]).toBe('message') // the skipped one at +25
    expect(kinds).toContain('approval')
    expect(kinds).toContain('approval-end')
    expect(kinds).toContain('limit')
    expect(kinds).toContain('team')
    expect(s.timeline.filter((x) => x.kind === 'message')).toHaveLength(3) // delivered is not a new row
  })

  it('keeps only the scope asked for, and clips spans to the period', () => {
    const only1 = summarize(events, { now: T0 + 30 * MIN, from: T0 + 5 * MIN, live, paneIds: new Set(['p1']) })
    expect(only1.rows.map((r) => r.paneId)).toEqual(['p1'])
    expect(only1.rows[0].ms.working).toBe(5 * MIN)
  })

  it('shows closed agents as closed, and says when there is nothing', () => {
    const closed = summarize(events, { now: T0 + 30 * MIN, from: T0 - 60 * MIN, live: {} })
    expect(closed.rows.every((r) => r.state === 'closed' && !r.open)).toBe(true)
    expect(summarize([], { now: T0 }).empty).toBe(true)
  })
})

describe('journal of the shared notes', () => {
  const notes = `# Project notes

## Who does what

- not a journal line

## Journal

- 2026-09-24 Tessel: notes created.
- 2026-09-24 Codex (read-only review of a1): changes requested.
- 2026-09-24 Claude: fixed both review points.
`
  it('reads dated lines under "## Journal"', () => {
    const j = parseJournal(notes)
    expect(j.map((x) => x.author)).toEqual(['Tessel', 'Codex', 'Claude'])
    expect(j[1].text).toBe('changes requested.')
  })

  it('matches authors to agents by kind or title', () => {
    expect(authorMatches('Codex', codex)).toBe(true)
    expect(authorMatches('Claude', claude)).toBe(true)
    expect(authorMatches('Claude', codex)).toBe(false)
    const s = summarize([], {
      now: Date.parse('2026-09-25T10:00:00Z'),
      from: Date.parse('2026-09-20T00:00:00Z'),
      live: { p1: { state: 'idle', ...claude }, p2: { state: 'idle', ...codex } },
      journal: parseJournal(notes)
    })
    expect(s.rows.find((r) => r.paneId === 'p2').journal).toBe(1)
    expect(s.timeline.filter((x) => x.kind === 'journal')).toHaveLength(3)
  })
})

describe('log housekeeping', () => {
  it('drops events older than 30 days and caps the count', () => {
    const now = T0
    const old = { t: now - 31 * 24 * 3600 * 1000, type: 'message' }
    const many = Array.from({ length: MAX_EVENTS + 10 }, (_, i) => ({ t: now - i, type: 'message' }))
    expect(trimEvents([old, ...many], now)).toHaveLength(MAX_EVENTS)
    expect(trimEvents([old], now)).toHaveLength(0)
  })

  it('formats durations compactly', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(42 * 1000)).toBe('42 s')
    expect(formatDuration(4 * MIN)).toBe('4 min')
    expect(formatDuration(125 * MIN)).toBe('2 h 05')
    expect(formatDuration(28 * 60 * MIN)).toBe('1 d 4 h')
  })
})
