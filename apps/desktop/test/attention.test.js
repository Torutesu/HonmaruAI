import { describe, expect, it } from 'vitest'
import { isAway, IDLE_AFTER_SECONDS } from '../src/attention.js'

// The page in this app always reports itself visible (backgroundThrottling
// off), so whether anybody is at the window comes from the main process.
describe('isAway', () => {
  const here = { visible: true, minimized: false, locked: false, suspended: false, idleSeconds: 3 }
  it('is here while the window is up and someone is using the machine', () => {
    expect(isAway(here)).toBe(false)
  })
  it('is away in the tray, minimized, behind a locked screen or asleep', () => {
    expect(isAway({ ...here, visible: false })).toBe(true)
    expect(isAway({ ...here, minimized: true })).toBe(true)
    expect(isAway({ ...here, locked: true })).toBe(true)
    expect(isAway({ ...here, suspended: true })).toBe(true)
  })
  it('is away when nobody has touched the machine for a while', () => {
    expect(isAway({ ...here, idleSeconds: IDLE_AFTER_SECONDS - 1 })).toBe(false)
    expect(isAway({ ...here, idleSeconds: IDLE_AFTER_SECONDS })).toBe(true)
  })
})
