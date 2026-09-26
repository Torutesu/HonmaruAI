import { describe, it, expect } from 'vitest'
import { outsideSchedule, isQuiet, setQuietState } from './quiet'

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
