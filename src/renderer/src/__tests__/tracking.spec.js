import { describe, it, expect } from 'vitest'
import { trackAgent, formatSpan } from '../../../shared/tracking'

const M = 60 * 1000
const now = 1_000_000_000

describe('formatSpan', () => {
  it('reads like a clock', () => {
    expect(formatSpan(30 * 1000)).toBe('<1 min')
    expect(formatSpan(12 * M)).toBe('12 min')
    expect(formatSpan(65 * M)).toBe('1 h 05')
  })
})

describe('trackAgent', () => {
  const doing = { title: 'Fix it', column: 'doing', doingSince: now - 5 * M }

  it('says what it does and for how long', () => {
    expect(trackAgent({ state: 'working', since: now - 12 * M }, null, now)).toMatchObject({ text: 'Working · 12 min', level: 'ok' })
    expect(trackAgent({ state: 'idle', since: now - 30 * 1000 }, null, now).text).toBe('Idle · <1 min')
  })

  it('warns about an approval waiting, then alerts', () => {
    expect(trackAgent({ state: 'approval', since: now - 1 * M }, null, now).level).toBe('ok')
    expect(trackAgent({ state: 'approval', since: now - 3 * M }, null, now)).toMatchObject({ level: 'warn', reason: 'Waiting for your approval for 3 min.' })
    expect(trackAgent({ state: 'approval', since: now - 11 * M }, null, now).level).toBe('alert')
  })

  it('flags an agent quiet on an unfinished task', () => {
    expect(trackAgent({ state: 'idle', since: now - 5 * M }, doing, now).level).toBe('ok')
    const w = trackAgent({ state: 'idle', since: now - 12 * M }, doing, now)
    expect(w.level).toBe('warn')
    expect(w.reason).toMatch(/Quiet for 12 min while "Fix it" is not finished/)
    expect(trackAgent({ state: 'idle', since: now - 31 * M }, doing, now).level).toBe('alert')
  })

  it('does not flag a quiet agent without a task, or with a task in review', () => {
    expect(trackAgent({ state: 'idle', since: now - 90 * M }, null, now).level).toBe('ok')
    expect(trackAgent({ state: 'idle', since: now - 90 * M }, { ...doing, column: 'review' }, now).level).toBe('ok')
  })

  it('notes a long task, and the usage limit with its reset', () => {
    const long = { ...doing, doingSince: now - 75 * M }
    expect(trackAgent({ state: 'working', since: now - 2 * M }, long, now)).toMatchObject({ level: 'info', reason: 'Long-running task: on "Fix it" for 1 h 15.', onTask: '1 h 15' })
    expect(trackAgent({ state: 'limited', since: now, reset: '5pm' }, null, now)).toMatchObject({ text: 'Usage limit · resets 5pm', level: 'warn' })
  })
})
