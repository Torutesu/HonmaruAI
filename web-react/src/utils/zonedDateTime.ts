const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export function validTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true } catch { return false }
}

function partsAt(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant)
  return Object.fromEntries(parts.map(part => [part.type, part.value])) as Record<string, string>
}

export function localDateTimeInZone(value: string, timeZone: string): string {
  if (!RFC3339.test(value) || !validTimeZone(timeZone)) return ''
  const parts = partsAt(Date.parse(value), timeZone)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`
}

const wallEpoch = (year: number, month: number, day: number, hour: number, minute: number, second: number) => {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  return date.getTime()
}

// Resolve a wall time in an IANA zone. Ambiguous fold times choose the earlier
// instant; nonexistent gap times move forward by the size of the gap.
export function instantFromLocalDateTime(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match || !validTimeZone(timeZone)) return null
  const [, year, month, day, hour, minute, second = '00'] = match
  const date = `${year}-${month}-${day}`
  const check = new Date(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(check.getTime()) || check.toISOString().slice(0, 10) !== date || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null
  const desired = wallEpoch(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second))
  const offsets = new Set<number>()
  for (const delta of [-36, -24, -12, -6, 0, 6, 12, 24, 36]) {
    const candidate = desired + delta * 3600000
    const p = partsAt(candidate, timeZone)
    const represented = wallEpoch(Number(p.year), Number(p.month), Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
    offsets.add(represented - candidate)
  }
  const choices = [...offsets].map(offset => desired - offset)
  const exact = choices.filter(candidate => {
    const p = partsAt(candidate, timeZone)
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute && p.second === second
  }).sort((a, b) => a - b)
  if (exact.length) return new Date(exact[0]).toISOString()
  const after = choices.map(candidate => ({ candidate, p: partsAt(candidate, timeZone) })).map(item => ({ ...item, represented: wallEpoch(Number(item.p.year), Number(item.p.month), Number(item.p.day), Number(item.p.hour), Number(item.p.minute), Number(item.p.second)) })).filter(item => item.represented > desired).sort((a, b) => a.represented - b.represented)
  return after.length ? new Date(after[0].candidate).toISOString() : null
}

export function yearMonthInZone(instant: Date, timeZone: string): string {
  const parts = partsAt(instant.getTime(), validTimeZone(timeZone) ? timeZone : 'UTC')
  return `${parts.year}-${parts.month}`
}

export function timeInZone(value: string, timeZone: string): string {
  if (!RFC3339.test(value) || !validTimeZone(timeZone)) return ''
  return new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' }).format(Date.parse(value))
}
