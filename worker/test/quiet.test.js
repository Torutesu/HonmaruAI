import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { outsideSchedule, cleanSchedule, quietFor, pauseUntil } from "../src/quiet.js";
import { queueMessagePushes, sendDuePushes, PUSH_DELAY_MS } from "../src/pushes.js";
import { listMembers } from "../src/team.js";

// Quiet time: paused, or outside the hours you set — nothing reaches your
// phone or inbox, and it all waits in Activity.

const ORG = "personal:quiet";
let toru;
const ctx = { waitUntil: () => {} };
const call = (path, token, { method = "GET", body } = {}) => worker.fetch(new Request(`https://example.com${path}`, {
  method, headers: { "content-type": "application/json", "x-session-token": token }, body: body ? JSON.stringify(body) : undefined,
}), env, ctx);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  for (const [id, login, name] of [["4401", "toru", "Toru"], ["4402", "mika", "Mika"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "ja" });
    await upsertMembership(env.DB, ORG, id, "member");
  }
  await env.DB.prepare("UPDATE users SET timezone = 'Asia/Tokyo'").run();
  toru = await createSession(env.DB, "4401", "gho_t");
});

test("hours are read where the person is, overnight included", () => {
  const weekdays = cleanSchedule({ enabled: true, days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" });
  // Thursday 2026-09-24, Tokyo.
  expect(outsideSchedule(weekdays, "Asia/Tokyo", new Date("2026-09-24T01:00:00Z"))).toBe(false); // 10:00
  expect(outsideSchedule(weekdays, "Asia/Tokyo", new Date("2026-09-24T10:00:00Z"))).toBe(true); // 19:00
  expect(outsideSchedule(weekdays, "Asia/Tokyo", new Date("2026-09-26T01:00:00Z"))).toBe(true); // Saturday 10:00
  const nights = cleanSchedule({ enabled: true, days: [4], from: "22:00", to: "06:00" });
  expect(outsideSchedule(nights, "Asia/Tokyo", new Date("2026-09-24T14:00:00Z"))).toBe(false); // Thu 23:00
  expect(outsideSchedule(nights, "Asia/Tokyo", new Date("2026-09-24T19:00:00Z"))).toBe(false); // Fri 04:00, Thursday's night
  expect(outsideSchedule(nights, "Asia/Tokyo", new Date("2026-09-25T14:00:00Z"))).toBe(true); // Fri 23:00
  expect(outsideSchedule({ ...weekdays, enabled: false }, "Asia/Tokyo", new Date("2026-09-26T01:00:00Z"))).toBe(false);
  expect(pauseUntil(null)).toBeNull();
  expect(pauseUntil("2000-01-01T00:00:00Z")).toBeNull();
});

test("paused from /me, and a message waiting for a push is held until the pause ends", async () => {
  const set = await (await call("/me", toru, { method: "PUT", body: { pauseMinutes: 60 } })).json();
  expect(Date.parse(set.notifyPausedUntil) - Date.now()).toBeGreaterThan(59 * 60_000);
  expect((await quietFor(env.DB, "toru"))?.reason).toBe("paused");

  const members = await listMembers(env.DB, ORG, null);
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, body, kind, created_at) VALUES ('q1', ?1, 'dm:mika|toru', 'mika', 'lunch?', 'message', ?2)").bind(ORG, at).run();
  await queueMessagePushes(env, ORG, { id: "q1", kind: "message", channel: "dm:mika|toru", author_login: "mika", body: "lunch?", created_at: at }, { members });
  expect(await sendDuePushes(env, Date.now() + PUSH_DELAY_MS + 1000)).toEqual({ sent: 0, skipped: 0 });
  const held = await env.DB.prepare("SELECT due_at, last_error, sent_at FROM push_queue WHERE message_id = 'q1'").first();
  expect(held).toMatchObject({ last_error: "held", sent_at: null });
  expect(held.due_at).toBe(set.notifyPausedUntil);

  // Resumed; the hours set.
  const back = await (await call("/me", toru, { method: "PUT", body: { pausedUntil: null, notifySchedule: { enabled: true, days: [1, 2, 3], from: "10:00", to: "17:30" } } })).json();
  expect(back.notifyPausedUntil).toBeNull();
  expect(back.notifySchedule).toEqual({ enabled: true, days: [1, 2, 3], from: "10:00", to: "17:30" });
  const me = await (await call("/me", toru)).json();
  expect(me.notifySchedule.from).toBe("10:00");
});

test("quiet time ends at the end of a pause, at the next allowed minute, or not soon enough to hold for", async () => {
  const { quietEnds } = await import("../src/quiet.js");
  const { upsertUser } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "q9", login: "qq", name: "Q", avatarUrl: null, locale: "en" });
  const now = new Date("2026-10-13T10:00:00Z"); // a Tuesday, 19:00 in Tokyo
  expect(await quietEnds(env.DB, "qq", now)).toBeNull();
  await env.DB.prepare("UPDATE users SET notify_paused_until = '2026-10-13T10:45:00.000Z' WHERE login = 'qq'").run();
  expect((await quietEnds(env.DB, "qq", now)).toISOString()).toBe("2026-10-13T10:45:00.000Z");
  // Weekdays 9:00–18:00 in Tokyo: at 19:00, it opens at 9:00 tomorrow.
  await env.DB.prepare(`UPDATE users SET notify_paused_until = NULL, timezone = 'Asia/Tokyo', notify_schedule = '{"enabled":true,"days":[1,2,3,4,5],"from":"09:00","to":"18:00"}' WHERE login = 'qq'`).run();
  expect((await quietEnds(env.DB, "qq", now)).toISOString()).toBe("2026-10-14T00:00:00.000Z");
  // Friday evening: Monday is more than a hold away.
  expect(await quietEnds(env.DB, "qq", new Date("2026-10-16T10:00:00Z"))).toBeNull();
});
