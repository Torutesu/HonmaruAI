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

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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
