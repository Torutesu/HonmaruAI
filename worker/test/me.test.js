import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { localeFromRequest } from "../src/index.js";

// A person's language is the one thing every notification depends on, and
// until this existed it was written as "en" by every code path that touched
// the users table — so it was never anything else.

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { upsertUser, upsertMembership, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9101", login: "yuki", name: "Yuki", avatarUrl: null, locale: "ja" });
  await upsertMembership(env.DB, "acme/app", "9101", "admin");
  globalThis.__yuki = await createSession(env.DB, "9101", "gho_yuki");
});

const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });

test("GET /me says what language you read and what can reach you", async () => {
  const res = await SELF.fetch("https://example.com/me", { headers: headers(globalThis.__yuki) });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    login: "yuki", locale: "ja", notifyEmail: true, supportedLocales: expect.arrayContaining(["en", "ja"]),
  });
  expect((await SELF.fetch("https://example.com/me")).status).toBe(401);
});

test("PUT /me changes the language, normalizes the tag, and refuses nonsense", async () => {
  let res = await SELF.fetch("https://example.com/me", {
    method: "PUT", headers: headers(globalThis.__yuki), body: JSON.stringify({ locale: "en-US" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ locale: "en" });

  res = await SELF.fetch("https://example.com/me", {
    method: "PUT", headers: headers(globalThis.__yuki), body: JSON.stringify({ locale: "not a language" }),
  });
  expect(res.status).toBe(400);

  res = await SELF.fetch("https://example.com/me", {
    method: "PUT", headers: headers(globalThis.__yuki), body: JSON.stringify({ locale: "ja", notifyEmail: false }),
  });
  expect(await res.json()).toMatchObject({ locale: "ja", notifyEmail: false });
  const row = await env.DB.prepare("SELECT locale, notify_email FROM users WHERE github_id = '9101'").first();
  expect(row).toEqual({ locale: "ja", notify_email: 0 });
});

test("loading the org graph, or joining the relay, does not reset a chosen language", async () => {
  const { upsertUser, getUserByGithubId } = await import("../src/db.js");
  // What the graph route and authorizeOrgAccess now do: refresh the profile
  // without claiming to know the language.
  await upsertUser(env.DB, { githubId: "9101", login: "yuki", name: "Yuki K", avatarUrl: "http://a" });
  expect(await getUserByGithubId(env.DB, "9101")).toMatchObject({ name: "Yuki K", locale: "ja" });
  // An explicit value still wins, which is what the identity test relies on.
  await upsertUser(env.DB, { githubId: "9101", login: "yuki", name: "Yuki K", avatarUrl: "http://a", locale: "en" });
  expect(await getUserByGithubId(env.DB, "9101")).toMatchObject({ locale: "en" });
  await upsertUser(env.DB, { githubId: "9101", login: "yuki", name: "Yuki K", avatarUrl: "http://a", locale: "ja" });
});

test("a new account starts in the language its device speaks", async () => {
  expect(localeFromRequest(new Request("https://x", { headers: { "accept-language": "ja-JP,ja;q=0.9,en;q=0.8" } }))).toBe("ja");
  expect(localeFromRequest(new Request("https://x", { headers: { "accept-language": "en-US,en;q=0.9" } }))).toBe("en");
  expect(localeFromRequest(new Request("https://x"))).toBeNull();

  const res = await SELF.fetch("https://example.com/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "accept-language": "ja-JP,ja;q=0.9" },
    body: JSON.stringify({ email: "hana@example.com", password: "correct horse", name: "Hana" }),
  });
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("SELECT locale FROM users WHERE email = 'hana@example.com'").first();
  expect(row).toEqual({ locale: "ja" });

  // A signup that says nothing about language is English, as before.
  await SELF.fetch("https://example.com/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "sam@example.com", password: "correct horse", name: "Sam" }),
  });
  expect(await env.DB.prepare("SELECT locale FROM users WHERE email = 'sam@example.com'").first()).toEqual({ locale: "en" });
});

test("a GitHub account can say where email should go; an email account cannot change it", async () => {
  let res = await SELF.fetch("https://example.com/me", {
    method: "PUT", headers: headers(globalThis.__yuki), body: JSON.stringify({ email: "Yuki@Example.com " }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ email: "yuki@example.com" });
  expect(await (await SELF.fetch("https://example.com/me", { headers: headers(globalThis.__yuki) })).json())
    .toMatchObject({ email: "yuki@example.com", emailEditable: true });

  res = await SELF.fetch("https://example.com/me", {
    method: "PUT", headers: headers(globalThis.__yuki), body: JSON.stringify({ email: "not an address" }),
  });
  expect(res.status).toBe(400);

  // Cleared with an empty string.
  res = await SELF.fetch("https://example.com/me", {
    method: "PUT", headers: headers(globalThis.__yuki), body: JSON.stringify({ email: "" }),
  });
  expect(await res.json()).toMatchObject({ email: null });

  // An email account's address is its identity.
  const { setUserEmail, upsertUser } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "email:mai@example.com", login: "u:mai@example.com", name: "Mai", avatarUrl: null });
  expect(await setUserEmail(env.DB, "email:mai@example.com", "other@example.com")).toMatchObject({ error: expect.any(String) });
});
