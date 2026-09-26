// Quiet time, as this device knows it: notifications paused until a time,
// or outside the hours the person set. The server decides for pushes and
// email; this keeps the tab's own sounds quiet by the same rule.

export interface NotifySchedule { enabled: boolean; days: number[]; from: string; to: string }
export interface QuietState { pausedUntil: string | null; schedule: NotifySchedule | null }

export const DEFAULT_SCHEDULE: NotifySchedule = { enabled: false, days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }

let state: QuietState = { pausedUntil: null, schedule: null }
const listeners = new Set<() => void>()

export function setQuietState(next: QuietState): void {
  state = next
  for (const l of listeners) l()
}
export function getQuietState(): QuietState { return state }
export function onQuietChange(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/// Outside the hours, in this browser's own time — the same rule the
/// Worker applies in the person's timezone.
export function outsideSchedule(s: NotifySchedule | null, now = new Date()): boolean {
  if (!s?.enabled) return false
  const day = now.getDay()
  const at = now.getHours() * 60 + now.getMinutes()
  const from = minutes(s.from)
  const to = minutes(s.to)
  if (from === to) return !s.days.includes(day)
  if (from < to) return !s.days.includes(day) || at < from || at >= to
  if (at >= from) return !s.days.includes(day)
  if (at < to) return !s.days.includes((day + 6) % 7)
  return true
}

export function isQuiet(now = new Date()): boolean {
  if (state.pausedUntil && Date.parse(state.pausedUntil) > now.getTime()) return true
  return outsideSchedule(state.schedule, now)
}

/// Tomorrow at an hour, this browser's time: "until tomorrow morning".
export function tomorrowAt(hour: number, now = new Date()): string {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}
