import { expect, test } from "vitest";
import { parseSchedule, nextRunAt, nextScheduledRunAt, describeSchedule, isTimeZone, parseCronExpression, validateCronExpression, isIsoInstant } from "../src/schedule.js";

// A routine is made from one sentence. The parser is local, so the same
// sentence always makes the same schedule and costs nothing.

test("Japanese: weekly, daily mornings, weekdays with 午後, monthly", () => {
  expect(parseSchedule("毎週月曜9時に先週の決定と滞留をまとめて")).toEqual({
    cadence: "weekly", weekday: 1, hour: 9, minute: 0, instruction: "先週の決定と滞留をまとめて",
  });
  expect(parseSchedule("毎朝、自分待ちの判断を教えて")).toMatchObject({ cadence: "daily", hour: 9, instruction: "自分待ちの判断を教えて" });
  expect(parseSchedule("平日の午後5時半に今日決まったことを")).toMatchObject({ cadence: "weekdays", hour: 17, minute: 30 });
  expect(parseSchedule("毎月1日に先月のAI費用")).toMatchObject({ cadence: "monthly", monthday: 1, instruction: "先月のAI費用" });
  expect(parseSchedule("金曜日ごとに売上をまとめる")).toMatchObject({ cadence: "weekly", weekday: 5 });
});

test("English: every Monday at 9am, weekdays at 17:30, the 15th of every month", () => {
  expect(parseSchedule("Every Monday at 9am summarise last week's decisions")).toEqual({
    cadence: "weekly", weekday: 1, hour: 9, minute: 0, instruction: "summarise last week's decisions",
  });
  expect(parseSchedule("every weekday at 17:30, list what is stuck")).toMatchObject({ cadence: "weekdays", hour: 17, minute: 30, instruction: "list what is stuck" });
  expect(parseSchedule("on the 15th of every month review invoices")).toMatchObject({ cadence: "monthly", monthday: 15, instruction: "review invoices" });
  expect(parseSchedule("send me the pipeline every friday at 4pm")).toMatchObject({ cadence: "weekly", weekday: 5, hour: 16 });
});

test("a sentence with no cadence is not a schedule", () => {
  expect(parseSchedule("approve the supplier price")).toBeNull();
  expect(parseSchedule("月曜に打ち合わせを入れて")).toBeNull();
  expect(parseSchedule("")).toBeNull();
});

test("the next run is in the owner's zone, strictly after now", () => {
  const weekly = { cadence: "weekly", weekday: 1, hour: 9, minute: 0, timezone: "Asia/Tokyo" };
  // Thursday 2026-09-24 09:00 JST → Monday 2026-09-28 09:00 JST.
  expect(nextRunAt(weekly, new Date("2026-09-24T00:00:00Z"))).toBe("2026-09-28T00:00:00.000Z");
  // Exactly at the run time: the next one, not this one.
  expect(nextRunAt(weekly, new Date("2026-09-28T00:00:00Z"))).toBe("2026-10-05T00:00:00.000Z");
  // Weekdays skip the weekend.
  expect(nextRunAt({ cadence: "weekdays", hour: 9, minute: 0, timezone: "UTC" }, new Date("2026-09-25T10:00:00Z"))).toBe("2026-09-28T09:00:00.000Z");
  // New York in summer is UTC-4.
  expect(nextRunAt({ cadence: "daily", hour: 8, minute: 30, timezone: "America/New_York" }, new Date("2026-07-01T00:00:00Z"))).toBe("2026-07-01T12:30:00.000Z");
});

test("the 31st in a short month is its last day, and an unknown zone is UTC", () => {
  expect(nextRunAt({ cadence: "monthly", monthday: 31, hour: 9, minute: 0, timezone: "UTC" }, new Date("2026-02-01T00:00:00Z"))).toBe("2026-02-28T09:00:00.000Z");
  expect(nextRunAt({ cadence: "daily", hour: 9, minute: 0, timezone: "Mars/Olympus" }, new Date("2026-09-24T00:00:00Z"))).toBe("2026-09-24T09:00:00.000Z");
  expect(isTimeZone("Mars/Olympus")).toBe(false);
  expect(nextRunAt({ cadence: "hourly", hour: 9 }, new Date())).toBeNull();
});

test("a schedule reads back in the reader's language", () => {
  expect(describeSchedule({ cadence: "weekly", weekday: 1, hour: 9, minute: 0 }, "ja")).toBe("毎週月曜 09:00");
  expect(describeSchedule({ cadence: "weekdays", hour: 17, minute: 30 }, "en")).toBe("Weekdays at 17:30");
  expect(describeSchedule({ cadence: "monthly", monthday: 31, hour: 9, minute: 0 }, "ja")).toBe("毎月末 09:00");
});

test("cron schedules handle fields, lists, ranges, steps, and day-of-month/day-of-week OR semantics", () => {
  expect(validateCronExpression("0 9 * * 1-5").error).toBeUndefined();
  expect(parseCronExpression("0,30 9-17/2 1,15 * 1-5")).toMatchObject({ minute: { values: [0, 30] }, hour: { values: [9, 11, 13, 15, 17] } });
  expect(nextRunAt({ kind: "cron", expr: "0 9 * * 1-5", timezone: "UTC" }, new Date("2026-10-02T10:00:00Z"))).toBe("2026-10-05T09:00:00.000Z");
  expect(nextRunAt({ kind: "cron", expr: "0 9 1 * 1", timezone: "UTC" }, new Date("2026-10-02T10:00:00Z"))).toBe("2026-10-05T09:00:00.000Z");
  expect(validateCronExpression("0 9 31 2 *").error).toContain("never matches");
  expect(validateCronExpression("*/5 9 * * 1").error).toContain("10 minutes");
  // Multiple times can be valid when the calendar filter makes them run only
  // on one day of the year; validation measures actual occurrences.
  expect(validateCronExpression("0 9,17 1 1 *").error).toBeUndefined();
});

test("cron execution skips missing spring-forward wall times and handles repeated fall-back times", () => {
  expect(nextRunAt({ kind: "cron", expr: "30 2 * * *", timezone: "America/New_York" }, new Date("2026-03-08T05:00:00Z"))).toBe("2026-03-09T06:30:00.000Z");
  expect(nextRunAt({ kind: "cron", expr: "30 1 * * *", timezone: "America/New_York" }, new Date("2026-11-01T05:45:00Z"))).toBe("2026-11-01T06:30:00.000Z");
});

test("every schedules keep their phase through outages and one-time schedules fire only once", () => {
  const every = { kind: "every", everyMs: 60 * 60 * 1000 };
  expect(nextRunAt(every, new Date("2026-10-26T00:00:00Z"))).toBe("2026-10-26T01:00:00.000Z");
  expect(nextScheduledRunAt(every, "2026-10-26T01:00:00Z", new Date("2026-10-26T03:20:00Z"))).toBe("2026-10-26T04:00:00.000Z");
  const at = { kind: "at", at: "2026-10-26T09:30:00+09:00" };
  expect(isIsoInstant(at.at)).toBe(true);
  expect(nextRunAt(at, new Date("2026-10-26T00:00:00Z"))).toBe("2026-10-26T00:30:00.000Z");
  expect(nextScheduledRunAt(at, at.at, new Date("2026-10-26T01:00:00Z"))).toBeNull();
  expect(isIsoInstant("2026-02-30T09:00:00Z")).toBe(false);
});

test("new schedule forms have clear summaries", () => {
  expect(describeSchedule({ kind: "cron", expr: "0 9 * * 1-5", timezone: "Asia/Tokyo" }, "ja")).toBe("Cron: 0 9 * * 1-5（Asia/Tokyo）");
  expect(describeSchedule({ kind: "every", everyMs: 30 * 60 * 1000 }, "ja")).toBe("30分ごと");
  expect(describeSchedule({ kind: "every", everyMs: 2 * 60 * 60 * 1000 }, "en")).toBe("Every 2 hours");
});
