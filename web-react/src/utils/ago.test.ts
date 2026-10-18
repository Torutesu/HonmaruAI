import { describe, it, expect } from 'vitest'
import { datedTime, fullTime } from './ago'

// Noon on 1 October 2026 where the runner is: a Thursday in every time
// zone — noon UTC is already the 2nd in Auckland.
const noon = new Date(2026, 9, 1, 12).toISOString()

describe('a message’s time in full', () => {
  it('names the weekday, the date with its year, and the time', () => {
    const out = fullTime(noon, 'en-US')
    expect(out).toMatch(/^Thursday, October 1, 2026/)
    expect(out).toMatch(/\d{1,2}:\d{2}/)
  })

  it('is written in the reader’s language', () => {
    expect(fullTime(noon, 'ja-JP')).toMatch(/2026年10月1日木曜日/)
  })

  it('says nothing for a time it cannot read', () => {
    expect(fullTime('')).toBe('')
    expect(fullTime('not a date')).toBe('')
  })
})

describe('a message’s time in a thread', () => {
  const now = new Date(2026, 9, 1, 18)

  it('is the time alone today', () => {
    expect(datedTime(noon, 'en-US', now)).toMatch(/^12:00\sPM$/)
  })

  it('carries its date on an earlier day, and its year in an earlier year', () => {
    expect(datedTime(new Date(2026, 8, 28, 19, 28).toISOString(), 'en-US', now)).toMatch(/^Sep 28, 7:28\sPM$/)
    expect(datedTime(new Date(2025, 11, 31, 5, 41).toISOString(), 'en-US', now)).toMatch(/^Dec 31, 2025, 5:41\sAM$/)
  })

  it('is written in the reader’s language and order', () => {
    expect(datedTime(new Date(2026, 8, 28, 19, 28).toISOString(), 'ja-JP', now)).toBe('9月28日 19:28')
    expect(datedTime(new Date(2026, 8, 28, 19, 28).toISOString(), 'de-DE', now)).toMatch(/^28\. Sept?\., 19:28$/)
  })

  it('says nothing for a time it cannot read', () => {
    expect(datedTime('not a date')).toBe('')
  })
})
