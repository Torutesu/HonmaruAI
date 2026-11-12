// Datetimes are stored at millisecond precision, matching JS Date and the
// visible editor precision. Reject finer fractions instead of truncating.
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseRfc3339(value) {
  if (typeof value !== 'string') return null;
  const match = RFC3339.exec(value);
  if (!match) return null;
  const [, ys, mos, ds, hs, mis, ss, fraction = '', zone] = match;
  const year = Number(ys), month = Number(mos), day = Number(ds), hour = Number(hs), minute = Number(mis), second = Number(ss);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || !isValidDateOnly(`${ys}-${mos}-${ds}`)) return null;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3)), offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const millis = Number((fraction + '000').slice(0, 3));
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return null;
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millis);
  const offset = zone === 'Z' ? 0 : (zone[0] === '+' ? 1 : -1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  if (stamp !== local.getTime() - offset * 60000) return null;
  return stamp;
}

export function validTimeZone(value) {
  if (typeof value !== 'string' || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

export function dateInTimeZone(instant, timeZone) {
  if (!Number.isFinite(instant) || !validTimeZone(timeZone)) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
