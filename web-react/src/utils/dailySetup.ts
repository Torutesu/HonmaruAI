import type { Business } from '../types/card'

/// One time of day for the daily report: on or off, and when.
export interface DailySlot { on: boolean; hour: number; minute: number }

/// The daily report as it is being set up — in onboarding, before any of it
/// is saved. `channel` is `b:<slug>` for one that exists, or NEW_CHANNEL
/// with `newName` for one to make.
export interface DailySetup {
  cadence: 'weekdays' | 'daily'
  morning: DailySlot
  evening: DailySlot
  channel: string
  newName: string
}

export const NEW_CHANNEL = '__new'

/// What a team's daily-report channel is called, in the languages the
/// screens speak — so a second person joining finds the first one's channel
/// rather than making another beside it.
export const DAILY_CHANNEL_SLUGS = ['daily-reports', '日報', 'informes-diarios', 'rapports-quotidiens', 'tagesberichte']

/// 08:00 and 22:00, weekdays, into the team's daily-report channel if it has
/// one and a new one named in the reader's language if not.
export function defaultDailySetup(businesses: Business[], newName: string): DailySetup {
  const existing = businesses.find((b) => DAILY_CHANNEL_SLUGS.includes(b.slug))
  return {
    cadence: 'weekdays',
    morning: { on: true, hour: 8, minute: 0 },
    evening: { on: true, hour: 22, minute: 0 },
    channel: existing ? `b:${existing.slug}` : NEW_CHANNEL,
    newName,
  }
}

/// Whether there is anything to make: at least one time on, and somewhere
/// to post it.
export function dailyWanted(setup: DailySetup): boolean {
  if (!setup.morning.on && !setup.evening.on) return false
  return setup.channel === NEW_CHANNEL ? Boolean(setup.newName.trim()) : setup.channel.startsWith('b:')
}

function slot(value: unknown): DailySlot | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const hour = Number(v.hour)
  const minute = Number(v.minute)
  if (typeof v.on !== 'boolean' || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null
  return { on: v.on, hour, minute }
}

/// A saved setup read back, or null when it is not one.
export function readDailySetup(value: unknown): DailySetup | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const morning = slot(v.morning)
  const evening = slot(v.evening)
  if (!morning || !evening) return null
  if (v.cadence !== 'weekdays' && v.cadence !== 'daily') return null
  if (typeof v.channel !== 'string' || v.channel.length > 120 || typeof v.newName !== 'string' || v.newName.length > 80) return null
  return { cadence: v.cadence, morning, evening, channel: v.channel, newName: v.newName }
}
