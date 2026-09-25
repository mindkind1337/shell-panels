import { describe, it, expect } from 'vitest'
import { parseLeadRequest, findTaskByTitle, leadGuide } from '../../../shared/leadRequests'

describe('lead requests', () => {
  it('reads a task for a teammate or a new agent', () => {
    expect(parseLeadRequest({ action: 'task', title: ' Fix it ', brief: 'b', agent: '#3' })).toEqual({
      ok: true,
      action: 'task',
      title: 'Fix it',
      brief: 'b',
      num: 3,
      kind: null,
      ownCopy: true
    })
    expect(parseLeadRequest({ action: 'task', title: 'X', agent: 'Codex', own_copy: false })).toMatchObject({
      num: null,
      kind: 'codex',
      ownCopy: false
    })
    expect(parseLeadRequest({ action: 'task', title: 'X', agent: 2 }).num).toBe(2)
  })
  it('refuses incomplete or unknown requests', () => {
    expect(parseLeadRequest(null).ok).toBe(false)
    expect(parseLeadRequest([]).ok).toBe(false)
    expect(parseLeadRequest({ action: 'task', agent: '#1' }).error).toMatch(/title/)
    expect(parseLeadRequest({ action: 'task', title: 'x' }).error).toMatch(/agent/)
    expect(parseLeadRequest({ action: 'task', title: 'x', agent: 'rm -rf /' }).ok).toBe(false)
    expect(parseLeadRequest({ action: 'merge', task: 'x' }).error).toMatch(/unknown action/)
    expect(parseLeadRequest({ action: 'changes', task: 'x' }).error).toMatch(/text/)
    expect(parseLeadRequest({ action: 'message', to: 'bob', text: 'hi' }).ok).toBe(false)
  })
  it('reads messages, approvals and change requests', () => {
    expect(parseLeadRequest({ action: 'message', to: 'team', text: 'hi' })).toMatchObject({ ok: true, to: 'team' })
    expect(parseLeadRequest({ action: 'message', to: '#2', text: 'hi' })).toMatchObject({ ok: true, to: 'one', num: 2 })
    expect(parseLeadRequest({ action: 'APPROVE', task: 'Fix it', note: 'good' })).toMatchObject({ ok: true, action: 'approve', text: 'good' })
    expect(parseLeadRequest({ action: 'changes', task: 'Fix it', text: 'more' })).toMatchObject({ ok: true, action: 'changes' })
  })
  it('caps long text', () => {
    expect(parseLeadRequest({ action: 'message', to: 'team', text: 'x'.repeat(9000) }).text).toHaveLength(6000)
  })
  it('finds a task by its title', () => {
    const tasks = [{ title: 'Fix the header' }, { title: 'Fix the footer' }, { title: 'Docs' }]
    expect(findTaskByTitle(tasks, 'fix the HEADER')).toBe(tasks[0])
    expect(findTaskByTitle(tasks, 'Doc')).toBe(tasks[2])
    expect(findTaskByTitle(tasks, 'Fix the')).toBe(null)
  })
  it('explains the role', () => {
    const g = leadGuide({ teamName: 'Team 1', inbox: 'C:/p/.tessel/lead/abc', members: ['#2 Codex CLI'], kinds: ['codex', 'claude'] })
    expect(g).toMatch(/lead the team "Team 1"/)
    expect(g).toMatch(/C:\/p\/.tessel\/lead\/abc/)
    expect(g).toMatch(/"codex", "claude"/)
    expect(g).toMatch(/do not merge/)
  })
})
