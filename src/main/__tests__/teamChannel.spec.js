import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, dirname } from 'path'
import { ensureTeamChannel, pollTeamChannel, ackTeamDelivery } from '../teamChannel'

describe('persistent team channel', () => {
  let dir, outboxes
  const teamId = 'team-1'
  const members = [
    { id: 'pane-a', num: 1, title: 'Codex' },
    { id: 'pane-b', num: 2, title: 'Claude' },
    { id: 'pane-c', num: 3, title: 'Gemini' }
  ]
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-channel-'))
    const ready = ensureTeamChannel({ dir, teamId, members })
    expect(ready.ok).toBe(true)
    expect(ready.outboxes[0].guide).toMatch(/"to":"#2"/)
    outboxes = Object.fromEntries(ready.outboxes.map((m) => [m.id, m.outbox]))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const put = (box, name, data) => fs.writeFileSync(join(box, `${name}.json`), JSON.stringify(data))

  it('delivers a direct message and a reply with persistent acknowledgements', () => {
    put(outboxes['pane-a'], 'one', { to: '#2', text: 'Please review this.' })
    const first = pollTeamChannel({ dir, teamId })
    expect(first.deliveries).toHaveLength(1)
    expect(first.deliveries[0]).toMatchObject({
      fromId: 'pane-a',
      toId: 'pane-b',
      text: 'Please review this.',
      status: 'pending'
    })
    const id = first.deliveries[0].id
    expect(fs.existsSync(join(outboxes['pane-a'], 'one.json'))).toBe(false)
    // A later process/poll sees the same undelivered item, without ingesting a duplicate.
    expect(pollTeamChannel({ dir, teamId }).deliveries.map((m) => m.id)).toEqual([id])
    expect(ackTeamDelivery({ dir, teamId, id, toId: 'pane-b' }).ok).toBe(true)
    const receipt = pollTeamChannel({ dir, teamId }).deliveries[0]
    expect(receipt).toMatchObject({ fromId: 'tessel', toId: 'pane-a', replyTo: id })
    expect(receipt.text).toMatch(/Delivered to #2 Claude/)
    expect(ackTeamDelivery({ dir, teamId, id: receipt.id, toId: 'pane-a' }).ok).toBe(true)
    expect(pollTeamChannel({ dir, teamId }).deliveries).toEqual([])
    put(outboxes['pane-b'], 'reply', { to: '#1', text: 'Looks good.', reply_to: id })
    expect(pollTeamChannel({ dir, teamId }).deliveries[0]).toMatchObject({
      fromId: 'pane-b',
      toId: 'pane-a',
      replyTo: id
    })
  })

  it('fans out to teammates and holds an unavailable recipient', () => {
    put(outboxes['pane-a'], 'all', { to: 'team', text: 'Status?' })
    const first = pollTeamChannel({ dir, teamId, availableIds: ['pane-b'] })
    expect(first.deliveries.map((m) => m.toId)).toEqual(['pane-b'])
    const next = pollTeamChannel({ dir, teamId, availableIds: ['pane-c'] })
    expect(next.deliveries.map((m) => m.toId)).toEqual(['pane-c'])
    expect(first.history).toHaveLength(2)
  })

  it('accepts a later message that reuses a filename', () => {
    put(outboxes['pane-a'], 'message', { to: '#2', text: 'First' })
    const first = pollTeamChannel({ dir, teamId }).deliveries[0]
    expect(ackTeamDelivery({ dir, teamId, id: first.id, toId: 'pane-b' }).ok).toBe(true)
    put(outboxes['pane-a'], 'message', { to: '#2', text: 'Second' })
    const second = pollTeamChannel({ dir, teamId }).deliveries.find((m) => m.text === 'Second')
    expect(second.text).toBe('Second')
    expect(second.id).not.toBe(first.id)
  })

  it('rejects an outsider and reports the error to the sender', () => {
    put(outboxes['pane-a'], 'bad', { to: '#99', text: 'Secret' })
    const res = pollTeamChannel({ dir, teamId })
    expect(res.deliveries).toHaveLength(1)
    expect(res.deliveries[0]).toMatchObject({ fromId: 'tessel', toId: 'pane-a' })
    expect(res.deliveries[0].text).toMatch(/recipient is not an active teammate/)
  })

  it('keeps tokens stable on reload and does not deliver to former teammates', () => {
    const oldBox = outboxes['pane-b']
    put(outboxes['pane-a'], 'before-leave', { to: '#2', text: 'Before you go' })
    expect(pollTeamChannel({ dir, teamId }).deliveries[0].toId).toBe('pane-b')
    const ready = ensureTeamChannel({ dir, teamId, members: [members[0], members[2]] })
    expect(ready.outboxes.find((m) => m.id === 'pane-a').outbox).toBe(outboxes['pane-a'])
    put(oldBox, 'stale', { to: '#1', text: 'No longer in team' })
    put(outboxes['pane-a'], 'former', { to: '#2', text: 'Hello?' })
    const res = pollTeamChannel({ dir, teamId })
    expect(res.history.some((m) => m.text === 'No longer in team')).toBe(false)
    expect(res.deliveries[0].text).toMatch(/not an active teammate/)
    expect(res.deliveries.some((m) => m.toId === 'pane-b')).toBe(false)
    expect(res.participants.find((m) => m.id === 'pane-b')).toMatchObject({
      title: 'Claude',
      active: false
    })
    expect(res.participants.some((m) => 'token' in m)).toBe(false)
  })

  it('rejects unsafe ids and waits for a partially written request', () => {
    expect(ensureTeamChannel({ dir, teamId: '../other', members }).ok).toBe(false)
    const file = join(outboxes['pane-a'], 'partial.json')
    fs.writeFileSync(file, '{"to":')
    expect(pollTeamChannel({ dir, teamId }).deliveries).toEqual([])
    fs.utimesSync(file, new Date(), new Date(Date.now() - 10000))
    expect(pollTeamChannel({ dir, teamId }).deliveries[0].text).toMatch(/invalid JSON/)
  })

  it('bounds delivered history without dropping an undelivered message', () => {
    const root = dirname(dirname(outboxes['pane-a']))
    const stateFile = join(root, 'state.json')
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    state.messages = Array.from({ length: 2001 }, (_, i) => ({
      id: `old-${i}`,
      fromId: 'pane-a',
      toId: 'pane-b',
      text: 'old',
      status: 'delivered',
      createdAt: i,
      deliveredAt: i
    }))
    state.messages.push({
      id: 'waiting',
      fromId: 'tessel',
      toId: 'pane-a',
      text: 'still waiting',
      status: 'pending'
    })
    state.messages.push({
      id: 'offline',
      fromId: 'pane-a',
      toId: 'pane-b',
      text: 'deliver later',
      status: 'pending'
    })
    fs.writeFileSync(stateFile, JSON.stringify(state))
    expect(ackTeamDelivery({ dir, teamId, id: 'waiting', toId: 'pane-a' }).ok).toBe(true)
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    expect(saved.messages).toHaveLength(2001)
    expect(saved.messages.some((m) => m.id === 'waiting')).toBe(true)
    expect(saved.messages.find((m) => m.id === 'offline')?.status).toBe('pending')
    expect(saved.messages.some((m) => m.id === 'old-0')).toBe(false)
  })
})
