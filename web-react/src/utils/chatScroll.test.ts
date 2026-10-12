import { describe, it, expect } from 'vitest'
import { countNewBelow, focusAfterJump, holdDelta, isAtBottom, isLooking, isNewSince, leavesGap, mergeById, reachesPast, shouldFollow, waitToSay } from './chatScroll'

/// A message said `i` minutes into the day, by a teammate unless it is yours.
const at = (i: number) => new Date(Date.UTC(2026, 8, 30, 0, i)).toISOString()
const msg = (i: number, extra: { mine?: boolean; body?: string } = {}) => ({ id: `m${i}`, createdAt: at(i), mine: false, body: `said at ${i}`, ...extra })
/// Messages `from` to `to`, oldest first, as a page comes from the server.
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => msg(from + k))

describe('at the bottom', () => {
  it('holds a few pixels short of the end, and lets go past the slack', () => {
    expect(isAtBottom({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 })).toBe(true)
    expect(isAtBottom({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1460 })).toBe(true)
    expect(isAtBottom({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1440 })).toBe(false)
    expect(isAtBottom({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1440 }, 80)).toBe(true)
  })

  it('a log too short to scroll is always at the bottom', () => {
    expect(isAtBottom({ scrollHeight: 300, clientHeight: 500, scrollTop: 0 })).toBe(true)
  })
})

describe('somebody looking', () => {
  const doc = (visibilityState: string, focused: boolean) => ({ visibilityState, hasFocus: () => focused })

  it('is a tab showing, in a window in front', () => {
    expect(isLooking(doc('visible', true))).toBe(true)
  })

  it('is not a tab in the background, nor a window behind another', () => {
    expect(isLooking(doc('hidden', true))).toBe(false)
    expect(isLooking(doc('hidden', false))).toBe(false)
    expect(isLooking(doc('visible', false))).toBe(false)
  })

  it('is not a desktop window nobody is at, though it reports itself visible', () => {
    // The desktop app runs its page unthrottled, so a hidden window, a
    // locked screen or an idle machine still says "visible": the app says
    // whether anyone is there (apps/desktop/src/attention.js).
    const w = globalThis as unknown as { window?: { honmaruDesktop?: unknown } }
    const had = w.window
    let away = true
    w.window = { honmaruDesktop: { isDesktop: true, platform: 'darwin', show: () => {}, away: () => away } }
    try {
      expect(isLooking(doc('visible', true))).toBe(false)
      away = false
      expect(isLooking(doc('visible', true))).toBe(true)
    } finally {
      w.window = had
    }
  })
})

describe('following what arrives', () => {
  it('does not pull a reader scrolled up back down for a teammate’s message', () => {
    expect(shouldFollow({ opened: false, atBottom: false, restoring: false, newestIsMine: false })).toBe(false)
  })

  it('goes to the newest when it is your own', () => {
    expect(shouldFollow({ opened: false, atBottom: false, restoring: false, newestIsMine: true })).toBe(true)
  })

  it('keeps up with a reader at the bottom', () => {
    expect(shouldFollow({ opened: false, atBottom: true, restoring: false, newestIsMine: false })).toBe(true)
  })

  it('always goes to the newest when a conversation opens', () => {
    expect(shouldFollow({ opened: true, atBottom: false, restoring: false, newestIsMine: false })).toBe(true)
    expect(shouldFollow({ opened: true, atBottom: false, restoring: true, newestIsMine: false })).toBe(true)
  })

  it('leaves an older page loading above where the reader was', () => {
    expect(shouldFollow({ opened: false, atBottom: true, restoring: true, newestIsMine: false })).toBe(false)
  })
})

describe('what is new', () => {
  it('is somebody else’s, said after the point', () => {
    expect(isNewSince(msg(5), at(4))).toBe(true)
    expect(isNewSince(msg(4), at(4))).toBe(false)
    expect(isNewSince(msg(5, { mine: true }), at(4))).toBe(false)
  })

  it('counts messages below, not how much longer the list got', () => {
    const before = range(10, 20)
    const since = before[before.length - 1].createdAt
    // Two from teammates and one of yours arrive…
    const now = [...before, msg(21), msg(22, { mine: true }), msg(23)]
    expect(countNewBelow(now, since)).toBe(2)
    // …and a page of older ones loading above adds nothing.
    expect(countNewBelow([...range(0, 9), ...now], since)).toBe(2)
    // One of them deleted is taken back off.
    expect(countNewBelow(now.filter((m) => m.id !== 'm23'), since)).toBe(1)
  })

  it('counts nothing for a reader at the bottom', () => {
    expect(countNewBelow([msg(1), msg(2)], null)).toBe(0)
  })
})

describe('the count, said aloud', () => {
  it('is said at once after a quiet spell', () => {
    expect(waitToSay(0, 60_000)).toBe(0)
    expect(waitToSay(10_000, 15_000)).toBe(0)
  })

  it('waits out the gap since it was last said', () => {
    expect(waitToSay(10_000, 11_000)).toBe(4000)
    expect(waitToSay(10_000, 11_000, 3000)).toBe(2000)
  })
})

describe('after "Jump to present"', () => {
  it('hands the focus on when the pill had it, clicked or pressed', () => {
    expect(focusAfterJump({ held: true, detail: 1, pointerType: 'mouse' })).toBe(true)
    expect(focusAfterJump({ held: true, detail: 0, pointerType: '' })).toBe(true)
  })

  it('hands it on when a keyboard or screen reader pressed it, focused or not', () => {
    expect(focusAfterJump({ held: false, detail: 0 })).toBe(true)
  })

  it('leaves it where it was when the pill never had it', () => {
    expect(focusAfterJump({ held: false, detail: 1, pointerType: 'mouse' })).toBe(false)
  })

  it('does not raise the on-screen keyboard after a tap', () => {
    expect(focusAfterJump({ held: true, detail: 1, pointerType: 'touch' })).toBe(false)
  })
})

describe('the newest page, merged', () => {
  it('keeps three pages loaded by scrolling up after the newest page is read again', () => {
    // Three pages of five, the oldest two loaded by scrolling up.
    const loaded = range(0, 14)
    // Two more said since; the newest page of five now starts at 12.
    const page = range(12, 16)
    const merged = mergeById(loaded, page)
    expect(merged.map((m) => m.id)).toEqual(range(0, 16).map((m) => m.id))
  })

  it('takes the page’s copy of a message it already had', () => {
    const loaded = range(0, 4)
    const page = [msg(3), { ...msg(4), body: 'edited' }]
    expect(mergeById(loaded, page).find((m) => m.id === 'm4')?.body).toBe('edited')
  })

  it('puts a message it did not have in its place by time', () => {
    const loaded = [msg(1), msg(3)]
    const page = [msg(1), msg(2), msg(3)]
    expect(mergeById(loaded, page).map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('drops one deleted meanwhile within the time the page covers', () => {
    const loaded = range(0, 6)
    const page = range(3, 6).filter((m) => m.id !== 'm5')
    expect(mergeById(loaded, page).map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm6'])
  })

  it('keeps what arrived after the page was read', () => {
    const loaded = [...range(0, 4), msg(9, { mine: true })]
    const page = range(0, 4)
    expect(mergeById(loaded, page).map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm9'])
  })

  it('is the page when nothing was loaded, and what was loaded when the page is empty', () => {
    expect(mergeById(undefined, range(0, 2)).map((m) => m.id)).toEqual(['m0', 'm1', 'm2'])
    expect(mergeById(range(0, 2), []).map((m) => m.id)).toEqual(['m0', 'm1', 'm2'])
  })
})

describe('older pages, and a hole', () => {
  it('knows when what is loaded reaches further back than the page', () => {
    expect(reachesPast(range(0, 14), range(10, 14))).toBe(true)
    expect(reachesPast(range(10, 14), range(10, 14))).toBe(false)
    expect(reachesPast(undefined, range(10, 14))).toBe(false)
    expect(reachesPast(range(10, 14), [])).toBe(false)
  })

  it('starts again when a full page begins after everything loaded', () => {
    expect(leavesGap(range(0, 4), range(10, 14), 5)).toBe(true)
    // Overlapping: it joins.
    expect(leavesGap(range(0, 10), range(10, 14), 5)).toBe(false)
    // Not full: the page reaches the start of the conversation.
    expect(leavesGap(range(0, 4), range(10, 12), 5)).toBe(false)
    expect(leavesGap(undefined, range(10, 14), 5)).toBe(false)
  })

  it('sees the hole under a live message that came in after the drop', () => {
    // Five loaded before the connection went, one said live after it came
    // back, then the newest page read again: 26 to 30, with 5 to 25 missing.
    const loaded = [...range(0, 4), msg(30)]
    const page = range(26, 30)
    expect(leavesGap(loaded, page, 5)).toBe(true)
    // Merged, it would have read as one conversation with a hole in it.
    expect(mergeById(loaded, page).map((m) => m.id)).toEqual([...range(0, 4), ...page].map((m) => m.id))
    // With the page's first message already loaded, it joins.
    expect(leavesGap([...range(0, 26), msg(30)], page, 5)).toBe(false)
  })

  it('joins a page that reaches no further back than what is loaded', () => {
    // Only a live message loaded, older than nothing on the page: no hole.
    expect(leavesGap([msg(30)], range(26, 30), 5)).toBe(false)
  })
})

describe('a message held in place while the log narrows (#249)', () => {
  it('scrolls by as much as the lines above it grew', () => {
    // Was 300px down the log; the wider lines above now wrap, pushing it to 380.
    expect(holdDelta({ was: 300, top: 380, bottom: 420, height: 800 })).toBe(80)
  })
  it('does nothing when nothing moved', () => {
    expect(holdDelta({ was: 300, top: 300, bottom: 340, height: 800 })).toBe(0)
  })
  it('keeps the foot of a message at the bottom in view, rather than its top', () => {
    // The newest message, itself taller now: its top held would hide its foot.
    expect(holdDelta({ was: 700, top: 700, bottom: 830, height: 800 })).toBe(30)
  })
  it('never moves the top of a tall message out of sight to show its foot', () => {
    expect(holdDelta({ was: 100, top: 100, bottom: 1400, height: 800 })).toBe(100)
  })
})
