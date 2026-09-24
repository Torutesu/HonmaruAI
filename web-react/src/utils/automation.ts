import type { Cadence, DecisionCard } from '../types/card'

// The small pieces the Automations screen, the Playbook and the report card
// share: what a routine is on the wire, how its schedule is edited, and how
// its cost and its times are said.

export interface Routine {
  id: string
  kind: 'report' | 'brief' | 'daily_report'
  title: string
  instruction: string
  cadence: Cadence
  weekday: number | null
  monthday: number | null
  hour: number
  minute: number
  timezone: string
  /// Already in the person's language: "毎週月曜 09:00".
  schedule: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastCardId: string | null
  lastError: string | null
  /// What the last run cost, in dollars. Null before the first run.
  lastUsd: number | null
  runs: number
  origin: 'manual' | 'proposal'
  recipient: { name: string; ref: string | null; self: boolean }
  /// A daily report's channel, `b:<slug>`; null for every other kind.
  channel?: string | null
  createdAt: string
}

/// What the person is editing: a routine before it is saved, or while it is
/// being changed. `recipient` is "me" or "member:<ref>".
export interface RoutineDraft {
  title?: string
  instruction: string
  cadence: Cadence
  weekday: number
  monthday: number
  hour: number
  minute: number
  recipient: string
  /// A daily report's channel, `b:<slug>`.
  channel?: string
}

export const CADENCES: Cadence[] = ['daily', 'weekdays', 'weekly', 'monthly']

/// Weekdays at nine: the answer to "when?" nobody has given yet.
export function emptyDraft(): RoutineDraft {
  return { instruction: '', cadence: 'weekdays', weekday: 1, monthday: 1, hour: 9, minute: 0, recipient: 'me' }
}

export function draftFromRoutine(r: Routine): RoutineDraft {
  return {
    title: r.title,
    instruction: r.instruction,
    cadence: r.cadence,
    weekday: r.weekday ?? 1,
    monthday: r.monthday ?? 1,
    hour: r.hour,
    minute: r.minute,
    recipient: r.recipient.self || !r.recipient.ref ? 'me' : r.recipient.ref,
    ...(r.channel ? { channel: r.channel } : {}),
  }
}

/// This browser's time zone, which is where "9am" means 9am.
export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/// The body the Worker takes. A weekday only rides with a weekly routine and
/// a day of the month only with a monthly one, so a routine switched from
/// weekly to daily does not carry a Monday it no longer means.
export function routineBody(draft: RoutineDraft, timezone = localTimeZone()): Record<string, unknown> {
  const body: Record<string, unknown> = {
    instruction: draft.instruction.trim(),
    cadence: draft.cadence,
    hour: draft.hour,
    minute: draft.minute,
    timezone,
    recipient: draft.recipient || 'me',
  }
  if (draft.title !== undefined && draft.title.trim()) body.title = draft.title.trim()
  if (draft.cadence === 'weekly') body.weekday = draft.weekday
  if (draft.cadence === 'monthly') body.monthday = draft.monthday
  if (draft.channel) body.channel = draft.channel
  return body
}

/// "09:05", for a time input.
export function timeValue(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/// A time input's value back into numbers. Null when it is not a time.
export function parseTime(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  return hour <= 23 && minute <= 59 ? { hour, minute } : null
}

/// Dollars, exactly enough to be honest: a run that cost four hundredths of
/// a cent says so rather than "$0.00".
export function money(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 0.01) return `$${usd.toFixed(4).replace(/0+$/, '')}`
  return `$${usd.toFixed(2)}`
}

/// A file name for a report, from its title: what a person would type,
/// without the characters a file system refuses.
export function reportFileName(title: string, ext = 'md'): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim()
  return `${base || 'report'}.${ext}`
}

/// The week's days in the reader's language, Sunday first — the order the
/// Worker numbers them in.
export function weekdayNames(locale: string, style: 'long' | 'short' = 'long'): string[] {
  // 7 January 2024 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    try { return new Intl.DateTimeFormat(locale, { weekday: style }).format(new Date(2024, 0, 7 + i)) } catch { return String(i) }
  })
}

// Where a card came from, when it is one of ours rather than a tool's name.
// English keys, translated where read.
const SOURCE_WORD: Record<string, string> = { Routine: 'Automation', Agent: 'Agent', 'Your AI': 'Your AI' }

/// The source a card names, in words: an agent's card says which agent — the
/// token it came through — so a person with two of them knows which is asking.
export function sourceLabel(card: Pick<DecisionCard, 'sourceApp' | 'sourceDetail'>, t: (key: string) => string): string {
  if (!card.sourceApp) return ''
  if (card.sourceApp === 'Agent' && card.sourceDetail) return `${t('Agent')} · ${card.sourceDetail}`
  return SOURCE_WORD[card.sourceApp] ? t(SOURCE_WORD[card.sourceApp]) : card.sourceApp
}
