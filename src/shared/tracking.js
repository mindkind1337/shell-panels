// Agent tracking: what each agent is doing, for how long, and whether it looks
// stuck. Pure, so the sidebar, the task cards, the pane header and the tests
// share the same rules.
//
// Levels: 'ok' (nothing to note), 'info' (worth knowing, not a problem),
// 'warn' (worth a look), 'alert' (needs you). The thresholds are starting
// values, not a standard (see Codex's research in .tessel/notes.md): a quiet
// agent may be compiling and a spinner may turn without progress, so nothing
// here claims an agent is stuck for sure.

export const TRACK = {
  approvalWarnMin: 2, // waiting for your approval
  approvalAlertMin: 10,
  idleOnTaskWarnMin: 10, // quiet while its task is still in Doing
  idleOnTaskAlertMin: 30,
  longTaskMin: 60 // one task in Doing for a long time (information only)
}

const MIN = 60 * 1000

// 45 s -> '<1 min', 12 min -> '12 min', 65 min -> '1 h 05'
export function formatSpan(ms) {
  const m = Math.floor(Math.max(0, ms) / MIN)
  if (m < 1) return '<1 min'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${String(m % 60).padStart(2, '0')}`
}

const STATE_WORD = {
  working: 'Working',
  idle: 'Idle',
  approval: 'Waiting for your approval',
  limited: 'Usage limit'
}

// agent: { state: 'working'|'idle'|'approval'|'limited', since (ms), reset }
// task: the task it is on ({ title, column, doingSince, startedAt }) or null
// -> { text, level, reason, minutes, task, onTask }
export function trackAgent(agent, task, now = Date.now()) {
  const state = (agent && agent.state) || 'idle'
  const inState = now - ((agent && agent.since) || now)
  const mins = Math.floor(inState / MIN)
  let text = `${STATE_WORD[state] || 'Idle'} · ${formatSpan(inState)}`
  // The reset time the agent printed; it is not taken as over just because
  // that time has passed (the limit clears when the agent works again).
  if (state === 'limited' && agent.reset) text = `Usage limit · resets ${agent.reset}`
  let level = 'ok'
  let reason = ''
  const doing = task && task.column === 'doing'
  const onTask = doing ? now - (task.doingSince || task.startedAt || now) : 0

  if (state === 'approval' && mins >= TRACK.approvalWarnMin) {
    level = mins >= TRACK.approvalAlertMin ? 'alert' : 'warn'
    reason = `Waiting for your approval for ${formatSpan(inState)}.`
  } else if (state === 'limited') {
    level = 'warn'
    reason = agent.reset ? `Out of usage (reset shown: ${agent.reset}).` : 'Out of usage.'
  } else if (doing && state === 'idle' && mins >= TRACK.idleOnTaskWarnMin) {
    level = mins >= TRACK.idleOnTaskAlertMin ? 'alert' : 'warn'
    reason = `Quiet for ${formatSpan(inState)} while "${task.title}" is not finished: it may be stuck or waiting for you.`
  } else if (doing && onTask >= TRACK.longTaskMin * MIN) {
    level = 'info'
    reason = `Long-running task: on "${task.title}" for ${formatSpan(onTask)}.`
  }
  return {
    text,
    level,
    reason,
    minutes: mins,
    task: task ? task.title : '',
    onTask: doing ? formatSpan(onTask) : ''
  }
}
