import { t } from './i18n'

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
