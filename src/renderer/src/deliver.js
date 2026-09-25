// Paste a message into an agent's terminal, press Enter, and find out whether
// the agent really took it. Pure (every effect goes through `d`), so the
// tests drive it with fake panes and timers.
//
// The screen cannot tell an agent's input box from its transcript, so the
// main evidence is what the agent does: once it works for a few seconds (or
// asks for approval) after Enter, it took the message. Enter is pressed again
// only when the agent stays quiet and the end of the message is still at the
// bottom of the screen (a draft); after two retries the delivery stays
// unconfirmed: no acknowledgement, and no blind second paste.
//
// d: { getPane(id) -> { paste, submit, screenText } | null, isBusy(id),
//      awaitingApproval(id), sleep(ms) -> Promise }
// -> 'confirmed' | 'unconfirmed' | 'requeue' (approval prompt before the
//    paste) | 'failed' (pane gone, write error, approval before Enter)

export const DELIVER = {
  settleMs: 500, // between paste and Enter
  stepMs: 500,
  acceptBusyMs: 4000, // working this long after Enter = it took the message
  quietMs: 1500, // quiet this long after Enter = look for a draft
  watchMs: 15000,
  retries: 2
}

// The end of the message is still in the last lines on screen.
export function draftVisible(pane, text) {
  if (!pane || !pane.screenText) return false
  const tail = String(text || '').replace(/\s+/g, ' ').trim().slice(-24)
  if (tail.length < 8) return false
  return pane.screenText(4).replace(/\s+/g, ' ').includes(tail)
}

async function watchAfterEnter(id, text, d) {
  let busyFor = 0
  let quietFor = 0
  for (let t = d.cfg.stepMs; t <= d.cfg.watchMs; t += d.cfg.stepMs) {
    await d.sleep(d.cfg.stepMs)
    const pane = d.getPane(id)
    if (!pane) return 'gone'
    // It asks to approve something: it is acting on the message.
    if (d.awaitingApproval(id)) return 'accepted'
    if (d.isBusy(id)) {
      busyFor += d.cfg.stepMs
      quietFor = 0
      if (busyFor >= d.cfg.acceptBusyMs) return 'accepted'
    } else {
      quietFor += d.cfg.stepMs
      busyFor = 0
      if (quietFor >= d.cfg.quietMs) return draftVisible(pane, text) ? 'draft' : 'unknown'
    }
  }
  return busyFor >= d.cfg.acceptBusyMs ? 'accepted' : 'unknown'
}

export async function pasteAndConfirm(id, text, deps) {
  const d = { ...deps, cfg: { ...DELIVER, ...(deps.cfg || {}) } }
  let pane = d.getPane(id)
  if (!pane) return 'failed'
  if (d.awaitingApproval(id)) return 'requeue'
  try {
    pane.paste(text)
  } catch {
    return 'failed'
  }
  await d.sleep(d.cfg.settleMs)
  for (let tries = 0; ; tries++) {
    pane = d.getPane(id)
    if (!pane) return 'failed'
    // Never press Enter into an approval prompt.
    if (d.awaitingApproval(id)) return tries === 0 ? 'failed' : 'unconfirmed'
    try {
      pane.submit()
    } catch {
      return 'failed'
    }
    const seen = await watchAfterEnter(id, text, d)
    if (seen === 'accepted') return 'confirmed'
    if (seen === 'gone') return 'failed'
    if (seen === 'draft' && tries < d.cfg.retries) continue
    return 'unconfirmed'
  }
}
