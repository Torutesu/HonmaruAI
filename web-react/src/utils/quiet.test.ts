import { describe, it, expect } from 'vitest'
import { outsideSchedule, isQuiet, setQuietState, scheduleSaver } from './quiet'

// The browser keeps its own sounds quiet by the rule the Worker uses for pushes.
describe('quiet time', () => {
  const weekdays = { enabled: true, days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }
  it('reads the hours and days, overnight included', () => {
    expect(outsideSchedule(weekdays, new Date(2026, 8, 24, 10, 0))).toBe(false) // Thursday
    expect(outsideSchedule(weekdays, new Date(2026, 8, 24, 19, 0))).toBe(true)
    expect(outsideSchedule(weekdays, new Date(2026, 8, 26, 10, 0))).toBe(true) // Saturday
    const nights = { enabled: true, days: [4], from: '22:00', to: '06:00' }
    expect(outsideSchedule(nights, new Date(2026, 8, 25, 4, 0))).toBe(false) // Thursday's night
    expect(outsideSchedule({ ...weekdays, enabled: false }, new Date(2026, 8, 26, 10, 0))).toBe(false)
  })
  it('is quiet while paused', () => {
    setQuietState({ pausedUntil: new Date(Date.now() + 60_000).toISOString(), schedule: null })
    expect(isQuiet()).toBe(true)
    setQuietState({ pausedUntil: null, schedule: null })
    expect(isQuiet()).toBe(false)
  })
})

// Each save sends the whole schedule; the server keeps whichever came last.
describe('saving the notification hours', () => {
  const start = { enabled: true, days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }
  const harness = (answer: (n: number) => boolean | Error = () => true) => {
    const sent: Array<typeof start> = []
    const pending: Array<() => void> = []
    const settled: boolean[] = []
    const save = scheduleSaver((s) => {
      sent.push(s)
      const n = sent.length
      return new Promise<boolean>((resolve, reject) => pending.push(() => {
        const a = answer(n)
        if (a instanceof Error) reject(a); else resolve(a)
      }))
    }, (ok) => settled.push(ok))
    const answerNext = async () => { pending.shift()!(); await new Promise((r) => setTimeout(r, 0)) }
    return { sent, settled, save, answerNext }
  }

  it('keeps both of From and To changed before the first save answered', async () => {
    const h = harness()
    h.save({ ...start, from: '10:00' })
    h.save({ ...start, from: '10:00', to: '17:00' })
    expect(h.sent).toEqual([{ ...start, from: '10:00' }])
    await h.answerNext()
    expect(h.sent.at(-1)).toEqual({ ...start, from: '10:00', to: '17:00' })
    await h.answerNext()
    expect(h.sent).toHaveLength(2)
    expect(h.settled).toEqual([true])
  })

  it('sends only the newest of the changes that waited, and the last one sent is the last one made', async () => {
    const h = harness()
    h.save({ ...start, days: [1, 2, 3, 4] })
    h.save({ ...start, days: [1, 2, 3] })
    h.save({ ...start, days: [1, 2] })
    await h.answerNext()
    await h.answerNext()
    expect(h.sent.map((s) => s.days)).toEqual([[1, 2, 3, 4], [1, 2]])
    expect(h.settled).toEqual([true])
  })

  it('still sends a later change when an earlier save failed, and says when the last one did', async () => {
    const h = harness((n) => (n === 1 ? new Error('offline') : false))
    h.save({ ...start, from: '10:00' })
    h.save({ ...start, from: '11:00' })
    await h.answerNext()
    expect(h.sent.at(-1)).toEqual({ ...start, from: '11:00' })
    await h.answerNext()
    expect(h.settled).toEqual([false])
    // Nothing is stuck: the next change goes straight out.
    h.save({ ...start, from: '12:00' })
    expect(h.sent).toHaveLength(3)
  })
})
