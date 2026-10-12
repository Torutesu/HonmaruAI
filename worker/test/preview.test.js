import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { previewOf, metaOf } from "../src/preview.js";

// A link shared in a message comes with its card: a page's own title,
// line and picture; a YouTube video's title, channel and thumbnail.

const ORG = "personal:preview";
let toru;
const get = async (path, token) => worker.fetch(new Request(`https://example.com${path}`, { headers: { "x-session-token": token || "" } }), env, { waitUntil: () => {} });

beforeEach(async () => {
  fetchMock.activate();
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "7101", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertMembership(env.DB, ORG, "7101", "member");
  toru = await createSession(env.DB, "7101", "gho_t");
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a page's Open Graph tags make its card", async () => {
  fetchMock.get("https://blog.example.com").intercept({ path: "/post", method: "GET" }).reply(200,
    `<html><head><title>Fallback</title><meta property="og:title" content="Pour-over &amp; you"><meta property="og:description" content="A 1:16 ratio."><meta property="og:image" content="/cover.jpg"><meta property="og:site_name" content="Bean Blog"></head></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
  expect(await previewOf("https://blog.example.com/post")).toMatchObject({
    kind: "page", title: "Pour-over & you", description: "A 1:16 ratio.", image: "https://blog.example.com/cover.jpg", site: "Bean Blog",
  });
});

test("a YouTube link plays where it is: title, channel, thumbnail and the video's id", async () => {
  fetchMock.get("https://www.youtube.com").intercept({ path: /^\/oembed\?/, method: "GET" }).reply(200, { title: "Coffee 101", author_name: "Bean TV" });
  expect(await previewOf("https://www.youtube.com/watch?v=8az8YGPT8XM")).toMatchObject({
    kind: "youtube", videoId: "8az8YGPT8XM", title: "Coffee 101", description: "Bean TV", image: "https://i.ytimg.com/vi/8az8YGPT8XM/hqdefault.jpg",
  });
});

test("members only, and never a private address", async () => {
  expect((await get(`/channels/link-preview?orgId=${encodeURIComponent(ORG)}&url=${encodeURIComponent("https://x.example/a")}`, "nobody")).status).toBe(401);
  const res = await (await get(`/channels/link-preview?orgId=${encodeURIComponent(ORG)}&url=${encodeURIComponent("http://127.0.0.1/admin")}`, toru)).json();
  expect(res.card).toBe(null);
});

test("meta tags in any order and quoting", () => {
  expect(metaOf(`<meta content='Hi' name='description'><title>T</title>`)).toMatchObject({ description: "Hi", __title: "T" });
});

test("a page that redirects to a private address makes no card", async () => {
  fetchMock.get("https://short.example.com").intercept({ path: "/x", method: "GET" }).reply(302, "", { headers: { location: "http://10.0.0.5/admin" } });
  expect(await previewOf("https://short.example.com/x")).toBeNull();
});
