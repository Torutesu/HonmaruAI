import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defaultDailySetup, dailyWanted, DAILY_CHANNEL_SLUGS, NEW_CHANNEL } from './dailySetup'
import { changeLocale, t } from './i18n'

// The daily report as onboarding offers it: 08:00 and 22:00, weekdays, into
// the team's daily-report channel when there is one.
describe('daily setup', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
    vi.stubGlobal('document', { documentElement: {} })
  })

  it('defaults to the morning and the evening, and to the team’s channel when it has one', () => {
    const fresh = defaultDailySetup([{ slug: 'kitchen', name: 'Kitchen' }], '日報')
    expect(fresh).toEqual({ cadence: 'weekdays', morning: { on: true, hour: 8, minute: 0 }, evening: { on: true, hour: 22, minute: 0 }, channel: NEW_CHANNEL, newName: '日報' })
    expect(defaultDailySetup([{ slug: 'kitchen', name: 'Kitchen' }, { slug: '日報', name: '日報' }], 'x').channel).toBe('b:日報')
  })

  it('makes nothing when both times are off or there is nowhere to post', () => {
    const on = defaultDailySetup([], 'daily-reports')
    expect(dailyWanted(on)).toBe(true)
    expect(dailyWanted({ ...on, morning: { ...on.morning, on: false }, evening: { ...on.evening, on: false } })).toBe(false)
    expect(dailyWanted({ ...on, newName: '  ' })).toBe(false)
    expect(dailyWanted({ ...on, channel: 'b:kitchen' })).toBe(true)
  })

  it('knows the channel name it proposes in every language the screens speak', () => {
    for (const code of ['en', 'ja', 'es', 'fr', 'de']) {
      changeLocale(code)
      expect(DAILY_CHANNEL_SLUGS).toContain(t('daily-reports'))
    }
    changeLocale('en')
  })
})
