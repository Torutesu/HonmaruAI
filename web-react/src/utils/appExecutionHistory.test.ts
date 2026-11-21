import { afterEach, expect, test, vi } from 'vitest'
import { formatActionStatus, formatHistoryDate } from './appExecutionHistory'

afterEach(() => vi.unstubAllGlobals())

test('execution history dates use the selected locale and identify invalid timestamps', () => {
  vi.stubGlobal('localStorage', { getItem: () => 'ja' })
  const timestamp = '2026-11-10T12:34:00.000Z'
  expect(formatHistoryDate(timestamp, key => key)).toBe(new Date(timestamp).toLocaleString('ja'))
  expect(formatHistoryDate('not-a-date', key => key)).toBe('Date unavailable')
})

test('execution status labels are translated without exposing unknown backend states', () => {
  const labels: Record<string, string> = { Queued: 'En cola', Running: 'En curso', Failed: 'Fallido', 'Unknown status': 'Estado desconocido' }
  const t = (key: string) => labels[key] || key
  expect(formatActionStatus('queued', t)).toBe('En cola')
  expect(formatActionStatus('running', t)).toBe('En curso')
  expect(formatActionStatus('failed', t)).toBe('Fallido')
  expect(formatActionStatus('new_backend_state', t)).toBe('Estado desconocido')
})
