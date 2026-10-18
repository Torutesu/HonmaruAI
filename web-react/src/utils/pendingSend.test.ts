import { describe, it, expect, vi } from 'vitest'
import type { ChannelMessage } from '../types/card'
import { arrive, drawUnder, echoOf, forgetOwnOutbox, isDoubleSend, isTemp, keepTemps, keptAsYours, keptUnsent, markFailed, markPending, outboxKey, provenYours, readUnsent, reconcile, refreshedReplies, refusedOutright, sendDeadline, sendTime, sharedOutboxKey, tempMessage, tempState, unsentAgain, wentAfterAll, withHeld } from './pendingSend'

const you = { name: 'Aiko', ref: 'm-aiko', avatar: null }
const at = new Date('2026-09-30T09:00:00.000Z')
const said = (id: string, body: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id, channel: 'b:hotel', kind: 'message', body, authorName: 'Aiko', authorRef: 'm-aiko',
  mine: true, cardId: null, createdAt: '2026-09-30T09:00:01.000Z', ...extra,
})
const ids = (list: ChannelMessage[]) => list.map((m) => m.id)

describe('a message on its way', () => {
  it('is yours, now, under a temporary id, and marked as on its way', () => {
    const m = tempMessage({ channel: 'b:hotel', body: 'Rooms are ready' }, you, at, () => 'abc')
    expect(m.id.startsWith('tmp-')).toBe(true)
    expect(m.id.endsWith('-abc')).toBe(true)
    expect(isTemp(m)).toBe(true)
    expect(m).toMatchObject({ channel: 'b:hotel', kind: 'message', body: 'Rooms are ready', mine: true, pending: true, authorName: 'Aiko', authorRef: 'm-aiko', createdAt: at.toISOString(), parentId: null, cardId: null })
    expect(m.files).toBeUndefined()
    expect(tempState(m)).toBe('pending')
  })

  it('carries its thread and its files', () => {
    const file = { id: 'f1', name: 'plan.pdf', type: 'application/pdf', size: 10, url: '/files/f1' }
    const m = tempMessage({ channel: 'b:hotel', body: '', parentId: 'p1', files: [file] }, you, at)
    expect(m.parentId).toBe('p1')
    expect(m.files).toEqual([file])
  })

  it('never takes the id of another sent in the same millisecond', () => {
    const a = tempMessage({ channel: 'b:hotel', body: 'one' }, you, at)
    const b = tempMessage({ channel: 'b:hotel', body: 'two' }, you, at)
    expect(a.id).not.toBe(b.id)
  })

  it('is drawn now, or after the newest message held when this clock is behind the server’s', () => {
    const now = new Date('2026-09-30T09:00:00.000Z')
    expect(sendTime([said('a', 'earlier', { createdAt: '2026-09-30T08:59:00.000Z' })], now)).toEqual(now)
    expect(sendTime(undefined, now)).toEqual(now)
    const ahead = [said('a', 'x', { createdAt: '2026-09-30T09:02:00.000Z' }), said('b', 'y', { createdAt: '2026-09-30T09:01:00.000Z' })]
    expect(sendTime(ahead, now).toISOString()).toBe('2026-09-30T09:02:00.001Z')
  })

  it('is sent once for a second Enter or a double tap, and again when said again on purpose', () => {
    const recent = new Map<string, number>()
    const t0 = 1_000_000
    expect(isDoubleSend(recent, 'b:hotel\n\nok\n', t0)).toBe(false)
    // The same press, before the box has cleared.
    expect(isDoubleSend(recent, 'b:hotel\n\nok\n', t0 + 40)).toBe(true)
    // Other words, or the same words elsewhere, are never held back.
    expect(isDoubleSend(recent, 'b:hotel\n\nok!\n', t0 + 60)).toBe(false)
    expect(isDoubleSend(recent, 'b:spa\n\nok\n', t0 + 80)).toBe(false)
    // "ok" again a moment later — the first may well still be on its way.
    expect(isDoubleSend(recent, 'b:hotel\n\nok\n', t0 + 1500)).toBe(false)
    expect(isDoubleSend(recent, 'b:hotel\n\nok\n', t0 + 1520)).toBe(true)
    // What is long past is not kept.
    isDoubleSend(recent, 'b:hotel\n\nlater\n', t0 + 60_000)
    expect([...recent.keys()]).toEqual(['b:hotel\n\nlater\n'])
  })

  it('a message from the server is never taken for one of ours', () => {
    expect(isTemp(said('0f9c-uuid', 'hi'))).toBe(false)
    expect(tempState(said('0f9c-uuid', 'hi'))).toBeUndefined()
  })
})

describe('the answer to the send', () => {
  it('puts the server’s copy where ours was', () => {
    const temp = tempMessage({ channel: 'b:hotel', body: 'second' }, you, at, () => 't')
    const list = [said('a', 'first'), temp, said('b', 'from Ken', { mine: false })]
    const out = reconcile(list, temp.id, said('real-2', 'second'))
    expect(ids(out)).toEqual(['a', 'real-2', 'b'])
    expect(out[1].pending).toBeUndefined()
  })

  it('when the socket brought the server’s copy first, ours just goes — once, and the copy shown stays', () => {
    const temp = tempMessage({ channel: 'b:hotel', body: 'second' }, you, at, () => 't')
    const fromSocket = said('real-2', 'second', { reactions: [{ emoji: '👍', count: 1, refs: ['m-ken'], mine: false }] })
    const list = [said('a', 'first'), temp, fromSocket]
    const out = reconcile(list, temp.id, said('real-2', 'second'))
    expect(ids(out)).toEqual(['a', 'real-2'])
    expect(out[1]).toBe(fromSocket)
  })

  it('shows the server’s copy even when ours is no longer held', () => {
    const out = reconcile([said('a', 'first')], 'tmp-gone', said('real-2', 'second'))
    expect(ids(out)).toEqual(['a', 'real-2'])
  })

  it('is drawn under ours’ key while ours is there, and never under a key already taken', () => {
    const temp = tempMessage({ channel: 'b:hotel', body: 'ok' }, you, at, () => 't')
    // The answer first: the same element carries on.
    const drawn = new Map<string, string>()
    drawUnder(drawn, 'real', temp.id, [said('a', 'first'), temp])
    expect(drawn.get('real')).toBe(temp.id)
    drawUnder(drawn, 'real', temp.id, [said('a', 'first'), temp])
    expect([...drawn]).toEqual([['real', temp.id]])

    // The same words from your phone came first and were taken for ours:
    // that one has the key, and the answer to the send gets its own.
    const taken = new Map([['from-phone', temp.id]])
    const list = arrive([temp], said('from-phone', 'ok'))
    drawUnder(taken, 'real', temp.id, list)
    expect(taken.has('real')).toBe(false)
    drawUnder(taken, 'real', temp.id, [temp])
    expect(taken.has('real')).toBe(false)

    // Ours gone from the list (a thread closed and opened again): nothing to carry on.
    const gone = new Map<string, string>()
    drawUnder(gone, 'real', temp.id, [said('a', 'first')])
    expect(gone.size).toBe(0)
  })

  it('changes nothing when the socket already put the server’s copy in ours’ place', () => {
    const list = [said('a', 'first'), said('real-2', 'second')]
    expect(reconcile(list, 'tmp-x', said('real-2', 'second'))).toBe(list)
  })
})

describe('a message that did not go', () => {
  it('stays where it was, with why, and goes again on Retry', () => {
    const temp = tempMessage({ channel: 'b:hotel', body: 'second' }, you, at, () => 't')
    const list = [said('a', 'first'), temp]
    const failed = markFailed(list, temp.id, 'That did not send. Try again.')
    expect(ids(failed)).toEqual(['a', temp.id])
    expect(failed[1]).toMatchObject({ body: 'second', pending: false, failed: 'That did not send. Try again.' })
    expect(tempState(failed[1])).toBe('failed')
    expect(failed[0]).toBe(list[0])
    const again = markPending(failed, temp.id)
    expect(again[1]).toMatchObject({ pending: true, failed: undefined })
    expect(tempState(again[1])).toBe('pending')
  })

  it('refused outright, is marked so — to be edited, not sent again as it is', () => {
    const temp = tempMessage({ channel: 'b:hotel', body: 'card 4242 4242 4242 4242' }, you, at, () => 't')
    const refused = markFailed([temp], temp.id, 'This can’t be sent here', true)
    expect(refused[0]).toMatchObject({ pending: false, failed: 'This can’t be sent here', refused: true })
    expect(tempState(refused[0])).toBe('failed')
    expect(markFailed([temp], temp.id, 'Timed out')[0].refused).toBeUndefined()
    expect(markPending(refused, temp.id)[0].refused).toBeUndefined()
  })

  it('is given up on when no answer comes in time, so what was sent after it can go', () => {
    vi.useFakeTimers()
    try {
      const ctrl = new AbortController()
      sendDeadline(ctrl, 25_000)
      vi.advanceTimersByTime(24_500)
      expect(ctrl.signal.aborted).toBe(false)
      vi.advanceTimersByTime(500)
      expect(ctrl.signal.aborted).toBe(true)

      // Answered in time: the clock stops, and nothing is aborted later.
      const answered = new AbortController()
      const stop = sendDeadline(answered, 25_000)
      vi.advanceTimersByTime(10_000)
      stop()
      vi.advanceTimersByTime(60_000)
      expect(answered.signal.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is not given up on while the person is being asked, and has its full time after they answer', () => {
    vi.useFakeTimers()
    try {
      const ctrl = new AbortController()
      let asking = false
      sendDeadline(ctrl, 25_000, () => asking)
      vi.advanceTimersByTime(20_000)
      asking = true
      vi.advanceTimersByTime(120_000)
      expect(ctrl.signal.aborted).toBe(false)
      asking = false
      vi.advanceTimersByTime(24_500)
      expect(ctrl.signal.aborted).toBe(false)
      vi.advanceTimersByTime(500)
      expect(ctrl.signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is refused outright when the server read it and said no, not when it could not answer', () => {
    // A data rule blocked it, or warned and "send it anyway" was declined;
    // the thread has gone; no right to post there.
    for (const status of [400, 403, 404, 409, 413, 422]) expect(refusedOutright(status)).toBe(true)
    // Too slow, too many, or the server fell over: worth sending again.
    for (const status of [401, 408, 429, 500, 502, 503, 504]) expect(refusedOutright(status)).toBe(false)
    expect(refusedOutright(201)).toBe(false)
  })
})

describe('the socket’s copy of a message', () => {
  it('changes the copy already held in place', () => {
    const list = [said('a', 'first'), said('b', 'second')]
    const out = arrive(list, said('a', 'first, edited', { editedAt: '2026-09-30T09:01:00.000Z' }))
    expect(ids(out)).toEqual(['a', 'b'])
    expect(out[0].body).toBe('first, edited')
  })

  it('takes the place of our own words still on their way, so they never show twice', () => {
    const temp = tempMessage({ channel: 'b:hotel', body: 'second\n' }, you, at, () => 't')
    const list = [said('a', 'first'), temp, said('k', 'from Ken', { mine: false })]
    const out = arrive(list, said('real-2', 'second'))
    expect(ids(out)).toEqual(['a', 'real-2', 'k'])
    // …and the answer to the send, after it, finds it already there.
    expect(ids(reconcile(out, temp.id, said('real-2', 'second')))).toEqual(['a', 'real-2', 'k'])
  })

  it('takes the place of ours that looked failed but did reach the server', () => {
    const temp = tempMessage({ channel: 'b:hotel', body: 'second' }, you, at, () => 't')
    const out = arrive(markFailed([temp], temp.id, 'Timed out'), said('real-2', 'second'))
    expect(ids(out)).toEqual(['real-2'])
    expect(out[0].failed).toBeUndefined()
  })

  it('is new, at the end, when it is somebody else’s, other words, another thread, or edited since', () => {
    const temp = tempMessage({ channel: 'b:hotel', body: 'ok' }, you, at, () => 't')
    const list = [temp]
    expect(ids(arrive(list, said('k', 'ok', { mine: false })))).toEqual([temp.id, 'k'])
    expect(ids(arrive(list, said('r', 'ok!')))).toEqual([temp.id, 'r'])
    expect(ids(arrive(list, said('r', 'ok', { parentId: 'p1' })))).toEqual([temp.id, 'r'])
    expect(ids(arrive(list, said('r', 'ok', { editedAt: '2026-09-30T09:01:00.000Z' })))).toEqual([temp.id, 'r'])
  })

  it('names the copy of ours it stands for, and only that one', () => {
    const one = tempMessage({ channel: 'b:hotel', body: 'one' }, you, at, () => 'a')
    const two = tempMessage({ channel: 'b:hotel', body: 'two' }, you, at, () => 'b')
    const list = [said('x', 'two'), one, two]
    expect(echoOf(list, said('real-2', 'two'))).toBe(two)
    expect(echoOf(list, said('x', 'two'))).toBeUndefined() // already held
    expect(echoOf(list, said('k', 'two', { mine: false }))).toBeUndefined()
    expect(echoOf(list, said('real-3', 'three'))).toBeUndefined()
  })

  it('stands for the one on its way, not an earlier one with the same words that failed', () => {
    const failed = markFailed([tempMessage({ channel: 'b:hotel', body: 'ok' }, you, at, () => 'a')], `tmp-${at.getTime().toString(36)}-a`, 'No')[0]
    const again = tempMessage({ channel: 'b:hotel', body: 'ok' }, you, at, () => 'b')
    expect(echoOf([failed, again], said('real', 'ok'))).toBe(again)
    expect(ids(arrive([failed, again], said('real', 'ok')))).toEqual([failed.id, 'real'])
  })

  it('matches a reply to ours in the same thread, files and all', () => {
    const file = { id: 'f1', name: 'plan.pdf', type: 'application/pdf', size: 10, url: '/files/f1' }
    const temp = tempMessage({ channel: 'b:hotel', body: '', parentId: 'p1', files: [file] }, you, at, () => 't')
    expect(ids(arrive([temp], said('r', '', { parentId: 'p1', files: [{ ...file, url: '/files/f1?sig=x' }] })))).toEqual(['r'])
    expect(ids(arrive([temp], said('r', '', { parentId: 'p1' })))).toEqual([temp.id, 'r'])
  })
})

describe('a reload from the server', () => {
  it('keeps what is still held only here, after what the server has', () => {
    const temp = tempMessage({ channel: 'b:hotel', body: 'second' }, you, at, () => 't')
    const failed = markFailed([tempMessage({ channel: 'b:hotel', body: 'third' }, you, at, () => 'u')], `tmp-${at.getTime().toString(36)}-u`, 'No')[0]
    const out = keepTemps([said('a', 'first'), said('b', 'from Ken', { mine: false })], [said('a', 'first'), temp, failed])
    expect(ids(out)).toEqual(['a', 'b', temp.id, failed.id])
    expect(out[3].failed).toBe('No')
  })

  it('is the server’s list as it came when nothing is held here', () => {
    const fresh = [said('a', 'first')]
    expect(keepTemps(fresh, undefined)).toBe(fresh)
    expect(keepTemps(fresh, [said('old', 'gone')])).toBe(fresh)
  })
})

describe('a thread read again while it is open', () => {
  const reply = (id: string, minute: number) => said(id, id, { parentId: 'p1', createdAt: `2026-09-30T09:0${minute}:00.000Z` })

  it('keeps replies on their way and that did not go, after what the server has', () => {
    const pending = tempMessage({ channel: 'b:hotel', body: 'on its way', parentId: 'p1' }, you, at, () => 't')
    const failed = markFailed([tempMessage({ channel: 'b:hotel', body: 'did not go', parentId: 'p1' }, you, at, () => 'u')], `tmp-${at.getTime().toString(36)}-u`, 'No')[0]
    const held = [reply('old', 1), pending, failed]
    const out = refreshedReplies([reply('old', 1)], held, new Set(ids(held)))
    expect(ids(out)).toEqual(['old', pending.id, failed.id])
    expect(out[2].failed).toBe('No')
  })

  it('keeps a reply the socket brought after the read left, once', () => {
    const before = new Set(['old'])
    const held = [reply('old', 1), reply('live', 3)]
    expect(ids(refreshedReplies([reply('old', 1)], held, before))).toEqual(['old', 'live'])
    // The answer has it too: drawn once.
    expect(ids(refreshedReplies([reply('old', 1), reply('live', 3)], held, before))).toEqual(['old', 'live'])
  })

  it('takes ours that landed meanwhile as the server’s copy, not twice', () => {
    const temp = tempMessage({ channel: 'b:hotel', body: 'mine', parentId: 'p1' }, you, at, () => 't')
    const before = new Set(['old', temp.id])
    // The answer to the send came before the read did: ours is the real one now.
    const held = [reply('old', 1), reply('mine', 2)]
    expect(ids(refreshedReplies([reply('old', 1)], held, before))).toEqual(['old', 'mine'])
    expect(ids(refreshedReplies([reply('old', 1), reply('mine', 2)], held, before))).toEqual(['old', 'mine'])
  })

  it('leaves out what the server no longer has, and what was deleted here since', () => {
    const before = new Set(['a', 'b', 'c'])
    // 'b' was deleted while the connection was down; 'c' deleted live since.
    const out = refreshedReplies([reply('a', 1), reply('c', 3)], [reply('a', 1), reply('b', 2)], before)
    expect(ids(out)).toEqual(['a'])
  })

  it('is the server’s list as it came when nothing changed here', () => {
    const fresh = [reply('a', 1)]
    expect(refreshedReplies(fresh, undefined, new Set())).toBe(fresh)
    expect(refreshedReplies(fresh, [reply('a', 1)], new Set(['a']))).toBe(fresh)
  })
})

describe('what did not go, kept in this browser', () => {
  const temp = (body: string, r: string, extra: Partial<ChannelMessage> = {}) => ({ ...tempMessage({ channel: 'b:hotel', body }, you, at, () => r), ...extra })

  it('reads back what was kept, leaving out anything it cannot read', () => {
    const kept = { said: temp('second', 'a'), decide: false, failed: 'That did not send. Try again.' }
    expect(readUnsent(JSON.stringify([kept]))).toEqual([kept])
    expect(readUnsent(null)).toEqual([])
    expect(readUnsent('not json')).toEqual([])
    expect(readUnsent('{"said":1}')).toEqual([])
    expect(readUnsent(JSON.stringify([kept, null, 3, { said: { ...kept.said, id: 'real-1' } }, { said: { id: 'tmp-x' } }]))).toEqual([kept])
  })

  it('is kept per person as well as per workspace', () => {
    expect(outboxKey('team:x', 'aiko')).toBe('outbox:team%3Ax:aiko')
    expect(outboxKey('team:x', 'aiko')).not.toBe(outboxKey('team:x', 'toru'))
    expect(outboxKey('team:x', 'aiko')).not.toBe(outboxKey('team:y', 'aiko'))
    // No workspace and person make another pair's key.
    expect(outboxKey('team', 'x:aiko')).not.toBe(outboxKey('team:x', 'aiko'))
    // Nor the key the whole workspace's was kept under before.
    expect(sharedOutboxKey('team:x')).toBe('outbox:team:x')
    for (const org of ['team:x', 'personal:ab12', 'acme/hotel']) expect(outboxKey(org, 'aiko')).not.toBe(sharedOutboxKey(org))
    // Every one of them is what signing out clears.
    expect(outboxKey('team:x', 'aiko').startsWith('outbox:')).toBe(true)
  })

  it('sign-out drops this person\'s outbox and leaves the next person\'s', () => {
    const data = new Map<string, string>([
      [outboxKey('team:x', 'aiko'), '[]'],
      [outboxKey('team:y', 'aiko'), '[]'],
      [outboxKey('team:x', 'toru'), '[]'],
    ])
    const storage = {
      get length() { return data.size },
      key: (i: number) => [...data.keys()][i] ?? null,
      removeItem: (k: string) => { data.delete(k) },
    }
    forgetOwnOutbox(storage, 'aiko')
    expect([...data.keys()]).toEqual([outboxKey('team:x', 'toru')])
  })

  it('is never taken for yours when it names someone else as its author', () => {
    const aikos = temp('mine', 'a')
    const torus = { ...aikos, authorRef: 'm-toru', authorName: 'Toru' }
    const nobodys = { ...aikos, authorRef: null }
    expect(keptAsYours(aikos, 'm-aiko')).toBe(true)
    expect(keptAsYours(torus, 'm-aiko')).toBe(false)
    // Sent before the team had loaded, or read before it has: the key decides.
    expect(keptAsYours(nobodys, 'm-aiko')).toBe(true)
    expect(keptAsYours(torus, undefined)).toBe(true)
    expect(keptAsYours(torus, null)).toBe(true)
  })

  it('kept for the whole workspace, is yours only when it names you', () => {
    const aikos = temp('mine', 'a')
    expect(provenYours(aikos, 'm-aiko')).toBe(true)
    expect(provenYours({ ...aikos, authorRef: 'm-toru' }, 'm-aiko')).toBe(false)
    expect(provenYours({ ...aikos, authorRef: null }, 'm-aiko')).toBe(false)
    expect(provenYours(aikos, undefined)).toBe(false)
    expect(provenYours({ ...aikos, authorRef: null }, null)).toBe(false)
  })

  it('keeps another tab’s as it left them, and this tab’s as they are now', () => {
    const mine = { said: temp('mine', 'm'), decide: false }
    const gone = { said: temp('sent since', 'g'), decide: false }
    const theirs = { said: temp('theirs', 't'), decide: true, failed: 'No' }
    const out = keptUnsent([gone, theirs], [mine], new Set([mine.said.id, gone.said.id]))
    expect(out.map((u) => u.said.id)).toEqual([theirs.said.id, mine.said.id])
  })

  it('leaves one only brought back in this tab as it is kept, until the tab does something with it', () => {
    const mine = { said: temp('mine', 'm'), decide: false }
    const back = { said: temp('from before', 'b'), decide: false, failed: 'That did not send. Try again.' }
    // Every tab brought it back; another sent it or threw it away since: it is not written back.
    expect(keptUnsent([], [back, mine], new Set([mine.said.id])).map((u) => u.said.id)).toEqual([mine.said.id])
    // Still kept: it stays as it is kept, not as this tab has it.
    const edited = { ...back, failed: 'Blocked', refused: true }
    expect(keptUnsent([edited], [back, mine], new Set([mine.said.id]))).toEqual([edited, mine])
    // Retried here, it is this tab's: kept as this tab has it now.
    const going = { said: back.said, decide: false }
    expect(keptUnsent([back], [going, mine], new Set([mine.said.id, back.said.id]))).toEqual([going, mine])
  })

  it('comes back failed, with why — or the reason it had — and refused stays refused', () => {
    const was = { said: temp('second', 'a', { pending: true }), decide: false }
    expect(unsentAgain(was, 'That did not send. Try again.')).toMatchObject({ id: was.said.id, body: 'second', pending: false, failed: 'That did not send. Try again.' })
    const refused = unsentAgain({ ...was, failed: 'Blocked', refused: true }, 'x')
    expect(refused).toMatchObject({ failed: 'Blocked', refused: true })
    expect(tempState(refused)).toBe('failed')
  })

  it('is not brought back when the server turns out to have it', () => {
    const held = temp('second', 'a')
    const landed = said('real', 'second', { createdAt: new Date(at.getTime() + 800).toISOString() })
    expect(wentAfterAll(held, [landed])).toBe(true)
    // A clock a little ahead of the server's.
    expect(wentAfterAll(held, [{ ...landed, createdAt: new Date(at.getTime() - 3000).toISOString() }])).toBe(true)
    // An earlier "second", somebody else's, or other words: it did not go.
    expect(wentAfterAll(held, [{ ...landed, createdAt: new Date(at.getTime() - 60_000).toISOString() }])).toBe(false)
    expect(wentAfterAll(held, [{ ...landed, mine: false }])).toBe(false)
    expect(wentAfterAll(held, [{ ...landed, body: 'third' }])).toBe(false)
  })

  it('is drawn once in a list, after what is there', () => {
    const one = temp('one', 'a')
    const list = [said('x', 'first'), one]
    expect(withHeld(list, [])).toBe(list)
    expect(withHeld(list, [one])).toBe(list)
    const two = temp('two', 'b')
    expect(ids(withHeld(list, [one, two]))).toEqual(['x', one.id, two.id])
  })
})
