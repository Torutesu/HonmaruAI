import { serverText } from "./serverCopy.js";
// When a routine runs, read from one sentence and computed in the owner's
// own time zone.
//
// "Every Monday at 9, summarise last week's decisions" is how people say
// it, so that is what the Routines box takes. The parser is local and
// deterministic — English and Japanese, the two languages the team writes
// instructions in — so making a routine costs no model call and gives the
// same answer every time. What it cannot read it leaves alone, and the
// person picks the cadence from the form instead.

export const CADENCES = ["daily", "weekdays", "weekly", "monthly"];
export const MIN_SCHEDULE_INTERVAL_MS = 10 * 60 * 1000;
// The only interval ceiling is JavaScript's largest representable instant;
// the public Kylon schedule contract specifies a minimum, not a ten-year cap.
export const MAX_SCHEDULE_INTERVAL_MS = 8_640_000_000_000_000;

const WEEKDAYS_EN = [
  ["sunday", "sun"], ["monday", "mon"], ["tuesday", "tue", "tues"], ["wednesday", "wed"],
  ["thursday", "thu", "thur", "thurs"], ["friday", "fri"], ["saturday", "sat"],
];
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

/// Whether a string names a time zone this runtime knows.
export function isTimeZone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/// The wall clock in `tz` at `date`: year, month (1-12), day, hour, minute,
/// weekday (0 = Sunday).
export function zonedParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(out.weekday);
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour) % 24, minute: Number(out.minute), weekday,
  };
}

/// Minutes `tz` is ahead of UTC at `date`.
function offsetMinutes(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

/// The instant a wall-clock time in `tz` names. Resolved twice, because the
/// offset at the guess can differ from the offset at the answer across a
/// daylight-saving change.
export function zonedTime({ year, month, day, hour, minute }, tz) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = naive - offsetMinutes(new Date(naive), tz) * 60000;
  guess = naive - offsetMinutes(new Date(guess), tz) * 60000;
  return new Date(guess);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/// Does this local date carry a run?
function matches(routine, { year, month, day, weekday }) {
  switch (routine.cadence) {
    case "daily": return true;
    case "weekdays": return weekday >= 1 && weekday <= 5;
    case "weekly": return weekday === Number(routine.weekday ?? 1);
    case "monthly": {
      // The 31st in a 30-day month is the 30th: a monthly report should not
      // skip February.
      const wanted = Math.min(Number(routine.monthday ?? 1), daysInMonth(year, month));
      return day === wanted;
    }
    default: return false;
  }
}

/// The first run strictly after `from`, as an ISO string, or null for a
/// routine that can never run.
export function nextRunAt(routine, from = new Date()) {
  if (routine?.kind === "at") return isIsoInstant(routine.at) && Date.parse(routine.at) > from.getTime() ? new Date(routine.at).toISOString() : null;
  if (routine?.kind === "every") {
    if (!Number.isSafeInteger(routine.everyMs) || routine.everyMs < MIN_SCHEDULE_INTERVAL_MS || routine.everyMs > MAX_SCHEDULE_INTERVAL_MS) return null;
    const next = from.getTime() + routine.everyMs;
    return Number.isSafeInteger(next) && next <= MAX_SCHEDULE_INTERVAL_MS ? new Date(next).toISOString() : null;
  }
  if (routine?.kind === "cron") return nextCronRunAt(routine, from);
  if (!CADENCES.includes(routine?.cadence)) return null;
  const tz = isTimeZone(routine.timezone) ? routine.timezone : "UTC";
  const hour = clampInt(routine.hour, 0, 23, 9);
  const minute = clampInt(routine.minute, 0, 59, 0);
  const start = zonedParts(from, tz);
  // Walk local calendar days from today; a monthly routine finds its day
  // within 62, everything else within 8.
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  for (let i = 0; i < 400; i += 1) {
    const local = {
      year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate(),
      weekday: cursor.getUTCDay(),
    };
    if (matches(routine, local)) {
      const at = zonedTime({ ...local, hour, minute }, tz);
      if (at.getTime() > from.getTime()) return at.toISOString();
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

/// Continue intervals from the previous scheduled instant, skipping missed
/// intervals after an outage without shifting the long-term cadence.
export function nextScheduledRunAt(routine, previousDueAt, now = new Date()) {
  if (routine?.kind !== "every") return nextRunAt(routine, now);
  const interval = routine.everyMs;
  const previous = Date.parse(previousDueAt || "");
  if (!Number.isSafeInteger(interval) || interval < MIN_SCHEDULE_INTERVAL_MS || interval > MAX_SCHEDULE_INTERVAL_MS || !Number.isFinite(previous)) return nextRunAt(routine, now);
  const steps = Math.max(1, Math.floor((now.getTime() - previous) / interval) + 1);
  const next = previous + steps * interval;
  return Number.isSafeInteger(next) && next <= MAX_SCHEDULE_INTERVAL_MS ? new Date(next).toISOString() : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cronField(source, min, max, map = value => value) {
  if (typeof source !== "string" || !source || source.length > 80) return null;
  const wildcard = source === "*" || /^\*\/\d+$/.test(source);
  const values = new Set();
  for (const part of source.split(",")) {
    if (!part) return null;
    const segments = part.split("/");
    if (segments.length > 2 || (segments.length === 2 && !/^\d+$/.test(segments[1]))) return null;
    const step = segments.length === 2 ? Number(segments[1]) : 1;
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) return null;
    const range = segments[0];
    let start, end;
    if (range === "*") { start = min; end = max; }
    else if (/^\d+-\d+$/.test(range)) {
      [start, end] = range.split("-").map(Number);
      if (start < min || end > max || start > end) return null;
    } else if (/^\d+$/.test(range)) {
      start = Number(range);
      if (start < min || start > max) return null;
      end = segments.length === 2 ? max : start;
    } else return null;
    for (let value = start; value <= end; value += step) values.add(map(value));
  }
  if (!values.size) return null;
  return { values: [...values].sort((a, b) => a - b), wildcard };
}

/// Parse the portable five-field cron form used by workflow schedules.
export function parseCronExpression(expr) {
  if (typeof expr !== "string" || expr.length > 240) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = cronField(parts[0], 0, 59);
  const hour = cronField(parts[1], 0, 23);
  const monthday = cronField(parts[2], 1, 31);
  const month = cronField(parts[3], 1, 12);
  const weekday = cronField(parts[4], 0, 7, value => value === 7 ? 0 : value);
  if (!minute || !hour || !monthday || !month || !weekday) return null;
  const times = [];
  for (const h of hour.values) for (const m of minute.values) times.push(h * 60 + m);
  times.sort((a, b) => a - b);
  const cron = { minute, hour, monthday, month, weekday, times, minGapMinutes: Infinity };
  const cycleStart = new Date(Date.UTC(2000, 0, 1));
  let first = null, previous = null;
  // Evaluate the complete 400-year Gregorian cycle so sparse date filters
  // (for example, several runs on one day a year) aren't rejected based on
  // times that can never coincide with an allowed date.
  for (let dayIndex = 0; dayIndex < 146097; dayIndex += 1) {
    const date = { year: cycleStart.getUTCFullYear(), month: cycleStart.getUTCMonth() + 1, day: cycleStart.getUTCDate(), weekday: cycleStart.getUTCDay() };
    if (cronMatchesDay(cron, date)) {
      for (let i = 0; i < times.length; i += 1) {
        const occurrence = dayIndex * 1440 + times[i];
        if (previous !== null) cron.minGapMinutes = Math.min(cron.minGapMinutes, occurrence - previous);
        if (first === null) first = occurrence;
        previous = occurrence;
      }
    }
    cycleStart.setUTCDate(cycleStart.getUTCDate() + 1);
  }
  if (first !== null && previous !== null) cron.minGapMinutes = Math.min(cron.minGapMinutes, 146097 * 1440 - previous + first);
  return cron;
}

/// Cron expressions must be valid and cannot fire more often than the
/// production Worker can safely admit them.
export function validateCronExpression(expr, minimumIntervalMs = MIN_SCHEDULE_INTERVAL_MS) {
  const cron = parseCronExpression(expr);
  if (!cron) return { error: "Use a five-field cron expression with numeric values, lists, ranges, and steps." };
  if (!Number.isFinite(cron.minGapMinutes)) return { error: "This cron expression never matches a calendar date." };
  if (cron.minGapMinutes * 60_000 < minimumIntervalMs) return { error: "A cron schedule must be at least 10 minutes between runs." };
  return { cron };
}

export function isIsoInstant(value) {
  if (typeof value !== "string" || value.length > 40) return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return false;
  const [, y, mo, d, h, mi, s, , zone] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return false;
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function cronMatchesDay(cron, local) {
  if (!cron.month.values.includes(local.month)) return false;
  const monthdayMatches = cron.monthday.values.includes(local.day);
  const weekdayMatches = cron.weekday.values.includes(local.weekday);
  if (cron.monthday.wildcard && cron.weekday.wildcard) return true;
  if (cron.monthday.wildcard) return weekdayMatches;
  if (cron.weekday.wildcard) return monthdayMatches;
  // Standard cron treats two restricted day fields as alternatives.
  return monthdayMatches || weekdayMatches;
}

function offsetsNearLocalDate({ year, month, day }, tz) {
  const noon = Date.UTC(year, month - 1, day, 12);
  const offsets = new Set();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) offsets.add(offsetMinutes(new Date(noon + hours * 3600000), tz));
  return [...offsets];
}

function instantsForLocalTime({ year, month, day, hour, minute }, tz, offsets) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const instants = [];
  for (const offset of offsets) {
    const at = new Date(wall - offset * 60000);
    const local = zonedParts(at, tz);
    if (local.year === year && local.month === month && local.day === day && local.hour === hour && local.minute === minute) instants.push(at);
  }
  return instants.sort((a, b) => a.getTime() - b.getTime());
}

function nextCronRunAt(routine, from, cron = parseCronExpression(routine.expr)) {
  if (!cron || !isTimeZone(routine.timezone)) return null;
  const localStart = zonedParts(from, routine.timezone);
  const cursor = new Date(Date.UTC(localStart.year, localStart.month - 1, localStart.day));
  // A Gregorian calendar repeats every 400 years, so this also detects
  // impossible dates such as February 31 without an unbounded search.
  for (let days = 0; days < 146097; days += 1) {
    const date = {
      year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate(), weekday: cursor.getUTCDay(),
    };
    if (cronMatchesDay(cron, date)) {
      const offsets = offsetsNearLocalDate(date, routine.timezone);
      if (offsets.length === 1) {
        for (const value of cron.times) {
          const hour = Math.floor(value / 60), minute = value % 60;
          if (date.year === localStart.year && date.month === localStart.month && date.day === localStart.day && (hour < localStart.hour || (hour === localStart.hour && minute <= localStart.minute))) continue;
          const at = instantsForLocalTime({ ...date, hour, minute }, routine.timezone, offsets)[0];
          if (at && at.getTime() > from.getTime()) return at.toISOString();
        }
      } else {
        let earliest = null;
        for (const value of cron.times) {
          const hour = Math.floor(value / 60), minute = value % 60;
          for (const at of instantsForLocalTime({ ...date, hour, minute }, routine.timezone, offsets)) {
            if (at.getTime() > from.getTime() && (!earliest || at < earliest)) earliest = at;
          }
        }
        if (earliest) return earliest.toISOString();
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

/// Read a cadence and a time out of a sentence.
///
/// Returns `{ cadence, weekday?, monthday?, hour, minute, instruction }`
/// with the schedule words taken out of the instruction, or null when the
/// sentence names no cadence at all.
export function parseSchedule(text) {
  const source = String(text || "").trim();
  if (!source) return null;
  let rest = source;
  const cut = (re) => {
    const m = rest.match(re);
    if (m) rest = (rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length)).trim();
    return m;
  };

  let cadence = null;
  let weekday;
  let monthday;
  let defaultHour = 9;

  // Japanese first: its markers are unambiguous.
  let m;
  if ((m = cut(/毎月\s*(\d{1,2})\s*日/u))) {
    cadence = "monthly"; monthday = Number(m[1]);
  } else if ((m = cut(/毎月(?:末)?/u))) {
    cadence = "monthly"; monthday = /末/.test(m[0]) ? 31 : 1;
  } else if ((m = cut(/毎週\s*([日月火水木金土])曜日?(?:の)?|([日月火水木金土])曜日?(?:ごと|毎)(?:に|の)?/u))) {
    cadence = "weekly"; weekday = WEEKDAYS_JA.indexOf(m[1] || m[2]);
  } else if ((m = cut(/毎週/u))) {
    cadence = "weekly"; weekday = 1;
  } else if ((m = cut(/平日(?:の)?(?:毎朝|朝|毎日)?/u))) {
    cadence = "weekdays";
  } else if ((m = cut(/毎朝/u))) {
    cadence = "daily"; defaultHour = 9;
  } else if ((m = cut(/毎晩|毎夕/u))) {
    cadence = "daily"; defaultHour = 18;
  } else if ((m = cut(/毎日|日次/u))) {
    cadence = "daily";
  }

  if (!cadence) {
    if ((m = cut(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:every|each|the)\s+month\b/i))) {
      cadence = "monthly"; monthday = Number(m[1]);
    } else if ((m = cut(/\b(?:every|each)\s+month(?:\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?)?/i))) {
      cadence = "monthly"; monthday = m[1] ? Number(m[1]) : 1;
    } else if ((m = cut(/\bmonthly\b/i))) {
      cadence = "monthly"; monthday = 1;
    } else if ((m = cut(/\b(?:every|each)\s+(?:weekday|work\s*day|business\s+day)s?(?:\s+morning)?\b|\bweekdays\b/i))) {
      cadence = "weekdays";
    } else if ((m = cut(new RegExp(`\\b(?:every|each|on)\\s+(${WEEKDAYS_EN.flat().join("|")})s?\\b(?:\\s+morning)?`, "i")))) {
      cadence = "weekly"; weekday = WEEKDAYS_EN.findIndex((names) => names.includes(m[1].toLowerCase()));
    } else if ((m = cut(/\b(?:every|each)\s+week\b|\bweekly\b/i))) {
      cadence = "weekly"; weekday = 1;
    } else if ((m = cut(/\b(?:every|each)\s+morning\b/i))) {
      cadence = "daily"; defaultHour = 9;
    } else if ((m = cut(/\b(?:every|each)\s+evening\b/i))) {
      cadence = "daily"; defaultHour = 18;
    } else if ((m = cut(/\b(?:every|each)\s+day\b|\bdaily\b/i))) {
      cadence = "daily";
    }
  }
  if (!cadence) return null;

  let hour = defaultHour;
  let minute = 0;
  if ((m = cut(/(午前|午後)?\s*(\d{1,2})\s*時\s*(?:(\d{1,2})\s*分|(半))?/u))) {
    hour = Number(m[2]) % 24;
    if (m[1] === "午後" && hour < 12) hour += 12;
    minute = m[4] ? 30 : (m[3] ? Number(m[3]) : 0);
  } else if ((m = cut(/(?:\bat\s+)?\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i))) {
    hour = Number(m[1]) % 24; minute = Number(m[2]);
    if (m[3]?.toLowerCase() === "pm" && hour < 12) hour += 12;
    if (m[3]?.toLowerCase() === "am" && hour === 12) hour = 0;
  } else if ((m = cut(/(?:\bat\s+)?\b(\d{1,2})\s*(am|pm)\b/i))) {
    hour = Number(m[1]) % 12;
    if (m[2].toLowerCase() === "pm") hour += 12;
  } else if ((m = cut(/\bat\s+(\d{1,2})\b/i))) {
    hour = Number(m[1]) % 24;
  }
  if (minute > 59) minute = 0;

  // What is left is the work. Strip the joints the schedule left behind:
  // "に", "、", "at", leading commas.
  const instruction = rest
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,、。:：\-–—]*(?:(?:に|は|で)(?=\S)\s*)?/u, "")
    .replace(/^(?:at|on|,)\s+/i, "")
    .replace(/[\s,、]+$/u, "")
    .trim();

  return {
    cadence,
    ...(cadence === "weekly" ? { weekday: weekday >= 0 ? weekday : 1 } : {}),
    ...(cadence === "monthly" ? { monthday: Math.min(31, Math.max(1, monthday || 1)) } : {}),
    hour, minute,
    instruction: instruction || source,
  };
}

/// "Every Monday at 09:00" in the reader's language, for cards and lists.
/// A language not written by hand needs `loadCopy` awaited first.
export function describeSchedule(routine, locale = "en") {
  if (routine.kind === "cron") return locale === "ja"
    ? `Cron: ${routine.expr}（${routine.timezone || "UTC"}）`
    : `Cron ${routine.expr} (${routine.timezone || "UTC"})`;
  if (routine.kind === "every") {
    const minutes = Math.round(Number(routine.everyMs) / 60000);
    if (locale === "ja") return minutes % 60 === 0 ? `${minutes / 60}時間ごと` : `${minutes}分ごと`;
    return minutes % 60 === 0 ? `Every ${minutes / 60} hours` : `Every ${minutes} minutes`;
  }
  if (routine.kind === "at") {
    const date = new Date(routine.at);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { timeZone: "UTC", timeZoneName: "short" }) : String(routine.at || "");
  }
  const hh = String(routine.hour ?? 9).padStart(2, "0");
  const mm = String(routine.minute ?? 0).padStart(2, "0");
  const time = `${hh}:${mm}`;
  switch (routine.cadence) {
    case "daily": return serverText(locale, "schedule.daily", { time });
    case "weekdays": return serverText(locale, "schedule.weekdays", { time });
    case "weekly": return serverText(locale, "schedule.weekly", { time, day: serverText(locale, `schedule.day${routine.weekday ?? 1}`) });
    case "monthly": return routine.monthday >= 31
      ? serverText(locale, "schedule.monthEnd", { time })
      : serverText(locale, "schedule.monthly", { time, day: routine.monthday ?? 1 });
    default: return time;
  }
}

/// The zone a person most likely lives in, from their language — for a
/// routine the AI proposes, before the person has told us.
export function defaultTimeZoneFor(locale) {
  return { ja: "Asia/Tokyo", de: "Europe/Berlin", fr: "Europe/Paris", es: "Europe/Madrid" }[locale] || "UTC";
}
