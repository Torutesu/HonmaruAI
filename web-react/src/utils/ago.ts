import { t } from './i18n'
import { formatDate } from './dateFormat'

/// "12m ago", the way the design writes it. Anything past a week is a date,
/// because "63d ago" is not something anyone reads as a duration.
export function ago(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 1) return t('just now')
  if (mins < 60) return t('{n}m ago', { n: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return t('{n}h ago', { n: hours })
  const days = Math.round(hours / 24)
  if (days <= 7) return t('{n}d ago', { n: days })
  return new Date(then).toLocaleDateString()
}

/// A moment in full, for the title on a message's time: the weekday, the
/// date with its year and the time — all that the short "3:04 PM" beside
/// a message leaves out.
export function fullTime(iso: string, locale?: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  return formatDate(then, locale, { dateStyle: 'full', timeStyle: 'short' })
}

/// A message's time where nothing around it says which day it was (a
/// thread, unlike a conversation, has no day lines): the time alone today,
/// the date before it on an earlier day, and the year too in an earlier year
/// — each in the reader's own order and words.
export function datedTime(iso: string, locale?: string, now: Date = new Date()): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const d = new Date(then)
  if (d.toDateString() === now.toDateString()) return formatDate(then, locale, { hour: 'numeric', minute: '2-digit' })
  const year = d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const }
  return formatDate(then, locale, { ...year, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
