import { getLocale } from './locale'

const ACTION_STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  pending: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
  awaiting_approval: 'Awaiting approval',
  waiting: 'Awaiting approval',
}

export function formatHistoryDate(value: string | number | null | undefined, t: (key: string) => string): string {
  const date = new Date(value ?? '')
  return Number.isFinite(date.getTime()) ? date.toLocaleString(getLocale()) : t('Date unavailable')
}

export function formatActionStatus(status: string, t: (key: string) => string): string {
  return t(ACTION_STATUS_LABELS[status] || 'Unknown status')
}
