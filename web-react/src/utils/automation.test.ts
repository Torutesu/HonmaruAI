import { describe, it, expect } from 'vitest'
import { awaitsPost, routineBody, money, parseTime, timeValue, reportFileName, emptyDraft, draftFromRoutine, weekdayNames, sourceLabel, type Routine } from './automation'

// What a routine is on the wire, and how its cost and time are said.
describe('automation', () => {
  it('sends a weekday only with a weekly routine, a day only with a monthly one', () => {
    const draft = { ...emptyDraft(), instruction: '  summarise last week  ', weekday: 3, monthday: 15 }
    expect(routineBody({ ...draft, cadence: 'weekly' }, 'Asia/Tokyo')).toEqual({
      instruction: 'summarise last week', cadence: 'weekly', hour: 9, minute: 0, timezone: 'Asia/Tokyo', recipient: 'me', weekday: 3,
    })
    expect(routineBody({ ...draft, cadence: 'monthly' }, 'UTC')).toMatchObject({ monthday: 15 })
    expect(routineBody({ ...draft, cadence: 'monthly' }, 'UTC')).not.toHaveProperty('weekday')
    expect(routineBody({ ...draft, cadence: 'daily' }, 'UTC')).not.toHaveProperty('weekday')
    expect(routineBody({ ...draft, cadence: 'daily', title: '  ' }, 'UTC')).not.toHaveProperty('title')
    expect(routineBody({ ...draft, cadence: 'daily', title: ' Weekly ' }, 'UTC')).toMatchObject({ title: 'Weekly' })
  })

  it('edits a routine for whoever it goes to', () => {
    const base = {
      id: 'r1', kind: 'report', title: 'T', instruction: 'I', cadence: 'weekly', weekday: 5, monthday: null, hour: 8, minute: 30,
      timezone: 'UTC', schedule: '', enabled: true, nextRunAt: null, lastRunAt: null, lastCardId: null, lastError: null, lastUsd: null,
      runs: 0, origin: 'manual', createdAt: '', recipient: { name: 'Me', ref: 'member:abc', self: true },
    } as Routine
    expect(draftFromRoutine(base)).toMatchObject({ weekday: 5, monthday: 1, recipient: 'me' })
    expect(draftFromRoutine({ ...base, recipient: { name: 'Yuki', ref: 'member:yuki', self: false } }).recipient).toBe('member:yuki')
  })

  it('says a fraction of a cent as one', () => {
    expect(money(0.0004)).toBe('$0.0004')
    expect(money(0.001)).toBe('$0.001')
    expect(money(0.00001)).toBe('<$0.0001')
    expect(money(0)).toBe('$0')
    expect(money(1.5)).toBe('$1.50')
  })

  it('reads and writes a time', () => {
    expect(timeValue(9, 5)).toBe('09:05')
    expect(parseTime('09:05')).toEqual({ hour: 9, minute: 5 })
    expect(parseTime('24:00')).toBeNull()
    expect(parseTime('')).toBeNull()
  })

  it('names a file after the report', () => {
    expect(reportFileName('Weekly: decisions / stuck')).toBe('Weekly decisions stuck.md')
    expect(reportFileName('   ')).toBe('report.md')
    expect(reportFileName('週次レポート')).toBe('週次レポート.md')
  })

  it('numbers the week from Sunday', () => {
    expect(weekdayNames('en-US')[0]).toBe('Sunday')
    expect(weekdayNames('en-US')[1]).toBe('Monday')
  })
})

describe('sourceLabel', () => {
  const t = (k: string) => `<${k}>`
  it('names our own sources in words, and an agent by its token', () => {
    expect(sourceLabel({ sourceApp: 'Routine' }, t)).toBe('<Automation>')
    expect(sourceLabel({ sourceApp: 'Agent', sourceDetail: 'Cursor' }, t)).toBe('<Agent> · Cursor')
    expect(sourceLabel({ sourceApp: 'Agent' }, t)).toBe('<Agent>')
    expect(sourceLabel({ sourceApp: 'Gmail', sourceDetail: 'x' }, t)).toBe('Gmail')
    expect(sourceLabel({}, t)).toBe('')
  })

  it('carries a daily report’s channel both ways, and no channel for anything else', () => {
    const daily = { ...emptyDraft(), cadence: 'weekdays' as const, hour: 18, minute: 30, channel: 'b:kitchen', instruction: 'x' }
    expect(routineBody(daily, 'Asia/Tokyo')).toMatchObject({ channel: 'b:kitchen', hour: 18, minute: 30, timezone: 'Asia/Tokyo' })
    expect(routineBody({ ...emptyDraft(), instruction: 'x' }, 'UTC')).not.toHaveProperty('channel')
    const routine = {
      id: 'r', kind: 'daily_report', title: '日報', instruction: 'x', cadence: 'weekdays', weekday: null, monthday: null, hour: 18, minute: 30,
      timezone: 'Asia/Tokyo', schedule: '平日 18:30', enabled: true, nextRunAt: null, lastRunAt: null, lastCardId: null, lastError: null,
      lastUsd: null, runs: 0, origin: 'manual', recipient: { name: 'Toru', ref: null, self: true }, channel: 'b:kitchen', createdAt: '',
    } as Routine
    expect(draftFromRoutine(routine).channel).toBe('b:kitchen')
  })

  it('keeps a daily draft on the feed until it is posted', () => {
    const draft = { status: 'pending', dailyReport: { routineId: 'r', channel: 'b:k', date: 'd', status: 'draft', text: 'x' } } as const
    expect(awaitsPost(draft)).toBe(true)
    expect(awaitsPost({ ...draft, dailyReport: { ...draft.dailyReport, status: 'posting' } })).toBe(true)
    expect(awaitsPost({ ...draft, dailyReport: { ...draft.dailyReport, status: 'posted' } })).toBe(false)
    expect(awaitsPost({ ...draft, dailyReport: { ...draft.dailyReport, status: 'expired' } })).toBe(false)
    expect(awaitsPost({ status: 'pending' })).toBe(false)
  })
})
