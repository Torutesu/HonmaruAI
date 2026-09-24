import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { notifyCard } from "../src/notify.js";
import { t, composeCodeEmail } from "../src/notifyCopy.js";
import { cardText } from "../src/cardCopy.js";
import { serverText } from "../src/serverCopy.js";
import { describeSchedule } from "../src/schedule.js";
import { loadCopy, forgetLearnedCopy, handWritten, text, catalogs } from "../src/copy.js";
import { resetProviderToken } from "../src/apns.js";

// The Worker's own words — a notification's routing line, an email, a reply
// in a channel, a schedule — reach a reader in their language whatever it is:
// written by hand for five, learned once from the model for every other.

const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;

const withModel = (over = {}) => ({
  ...env, OPENAI_API_KEY: "sk-test",
  APNS_KEY_ID: "ABC1234567", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "com.honmaru.ai",
  APNS_PRIVATE_KEY: TEST_P8, APNS_ENVIRONMENT: "sandbox",
  ...over,
});

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { upsertUser, registerDevice } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9101", login: "linh", name: "Linh", avatarUrl: null, locale: "vi" });
  await upsertUser(env.DB, { githubId: "9102", login: "alice", name: "Alice", avatarUrl: null, locale: "en" });
  await registerDevice(env.DB, { deviceToken: "tok-linh", githubId: "9101", login: "linh" });
  forgetLearnedCopy();
  resetProviderToken();
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// A model that "translates" by marking every string, placeholders kept —
// except where a test asks it to break one.
function interceptTranslator({ times = 1, calls = [], breakKey } = {}) {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => {
      const body = JSON.parse(opts.body);
      const english = JSON.parse(body.messages[1].content.split("\n\n").slice(1).join("\n\n"));
      calls.push({ language: body.messages[1].content.split("\n")[0], keys: Object.keys(english) });
      const out = Object.fromEntries(Object.entries(english).map(([k, v]) => [k, k === breakKey ? "VI: lost it" : `VI: ${v}`]));
      return { choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
    })
    .times(times);
}

test("the languages written by hand have every string, placeholders and all", () => {
  expect(handWritten()).toEqual(["en", "ja", "es", "fr", "de"]);
  // Spot checks across the three catalogs, each in a language not Japanese.
  expect(cardText("es", "Task for {name}", { name: "Ana" })).toBe("Tarea para Ana");
  expect(serverText("fr", "channel.made", { who: "vous", title: "Budget" })).toBe("Transformé en décision pour vous : Budget");
  expect(describeSchedule({ cadence: "weekly", weekday: 1, hour: 9, minute: 0 }, "de")).toBe("Jeden Montag um 09:00");
  expect(describeSchedule({ cadence: "weekly", weekday: 1, hour: 9, minute: 0 }, "en")).toBe("Every Monday at 09:00");
});

test("no hand-written language is missing a string or a placeholder", () => {
  const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const [name, tables] of catalogs()) {
    for (const lang of handWritten()) {
      for (const [key, english] of Object.entries(tables.en)) {
        expect(tables[lang][key], `${name}/${lang} is missing "${key}"`).toBeDefined();
        expect(holes(tables[lang][key]), `${name}/${lang} "${key}"`).toBe(holes(english));
      }
    }
  }
});

test("a reader of any other language is told in it: learned once, stored, and never asked for again", async () => {
  const calls = [];
  // One call per catalog: notification words, card words, the Worker's voice.
  interceptTranslator({ times: 3, calls });
  const sink = [];
  fetchMock.get("https://api.sandbox.push.apple.com")
    .intercept({ path: "/3/device/tok-linh", method: "POST", body: (b) => { sink.push(JSON.parse(b)); return true; } })
    .reply(200, {}).times(2);

  const card = { id: "c-1", recipientUserID: "linh", senderUserID: "alice", status: "pending", title: "Phê duyệt ngân sách" };
  await notifyCard(withModel(), { card, kind: "created", excludeLogin: "alice" });
  expect(sink[0].aps.alert).toEqual({ title: "Phê duyệt ngân sách", subtitle: "VI: alice's AI → you" });
  expect(calls.map((c) => c.language)).toEqual(Array(3).fill("Language: vi (Vietnamese)"));

  // The next notification in Vietnamese costs nothing: no model call is mocked.
  await notifyCard(withModel(), { card, kind: "nudged", excludeLogin: "alice" });
  expect(sink[1].aps.alert.subtitle).toBe("VI: alice is still waiting on your decision");

  // And a fresh isolate reads it back from D1 rather than asking again.
  forgetLearnedCopy();
  expect(t("vi", "waiting")).toBe("A decision is waiting");
  await loadCopy(withModel(), "vi");
  expect(t("vi", "waiting")).toBe("VI: A decision is waiting");
  expect(serverText("vi", "schedule.day1")).toBe("VI: Monday");
  const rows = await env.DB.prepare("SELECT catalog FROM copy_translations WHERE locale = 'vi' ORDER BY catalog").all();
  expect(rows.results.map((r) => r.catalog)).toEqual(["card", "notify", "server"]);
});

test("a learned string that lost a placeholder is not used: that one line stays English", async () => {
  interceptTranslator({ times: 3, breakKey: "fromAI" });
  await loadCopy(withModel(), "vi-VN");
  expect(t("vi", "fromAI", { name: "alice" })).toBe("alice's AI → you");
  expect(t("vi", "waiting")).toBe("VI: A decision is waiting");
});

test("the sign-in code email reaches a new person in their browser's language", async () => {
  interceptTranslator({ times: 3 });
  const lang = await loadCopy(withModel(), "vi-VN");
  const mail = composeCodeEmail({ code: "123456", locale: lang, minutes: 10 });
  expect(mail.subject).toBe("VI: 123456 is your Honmaru sign-in code");
  expect(mail.text).toContain("VI: It works for 10 minutes, once.");
});

test("no model, a made-up language, or a model that fails: English, and nothing is stored", async () => {
  await loadCopy({ ...env, OPENAI_API_KEY: undefined }, "vi");
  expect(t("vi", "waiting")).toBe("A decision is waiting");
  await loadCopy(withModel(), "xx");
  expect(t("xx", "waiting")).toBe("A decision is waiting");

  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(500, {}).times(3);
  await loadCopy(withModel(), "sw");
  expect(text("notify", "sw", "waiting")).toBe("A decision is waiting");
  // Not retried on every notification while the model is down.
  await loadCopy(withModel(), "sw");
  const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM copy_translations").first();
  expect(stored.n).toBe(0);
});
