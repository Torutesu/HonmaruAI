import { expect, test } from "vitest";
import { parseSchedule, nextRunAt, describeSchedule, isTimeZone } from "../src/schedule.js";

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
