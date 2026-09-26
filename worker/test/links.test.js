import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import { linksIn, isPublicUrl, classifyLink, pickTrack, transcriptText, readLink, readLinks, linksBlock } from "../src/links.js";

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("the links in a message: distinct, trimmed, public only", () => {
  expect(linksIn("見て https://youtu.be/dQw4w9WgXcQ。あと https://x.com/jack/status/20）と https://youtu.be/dQw4w9WgXcQ")).toEqual([
    "https://youtu.be/dQw4w9WgXcQ", "https://x.com/jack/status/20",
  ]);
  expect(linksIn("http://localhost:8787/x http://192.168.1.2/a http://10.0.0.1 https://user:pw@example.com http://intranet/x")).toEqual([]);
  expect(isPublicUrl("https://example.com/a")).toBe(true);
  expect(isPublicUrl("ftp://example.com")).toBe(false);
});

test("each link knows its reader", () => {
  expect(classifyLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10")).toEqual({ kind: "youtube", id: "dQw4w9WgXcQ" });
  expect(classifyLink("https://youtube.com/shorts/abcdefghijk")).toEqual({ kind: "youtube", id: "abcdefghijk" });
  expect(classifyLink("https://m.youtube.com/live/abcdefghijk?si=x")).toEqual({ kind: "youtube", id: "abcdefghijk" });
  expect(classifyLink("https://vt.tiktok.com/ZS123/")).toEqual({ kind: "tiktok" });
  expect(classifyLink("https://twitter.com/jack/status/20?s=20")).toEqual({ kind: "x", user: "jack", id: "20" });
  expect(classifyLink("https://x.com/jack")).toEqual({ kind: "page" });
});

test("captions: the reader's language, the video's own over automatic, as plain text", () => {
  const tracks = [{ languageCode: "en", kind: "asr", baseUrl: "a" }, { languageCode: "en", baseUrl: "b" }, { languageCode: "ja", kind: "asr", baseUrl: "c" }];
  expect(pickTrack(tracks, "en").baseUrl).toBe("b");
  expect(pickTrack(tracks, "ja").baseUrl).toBe("c");
  expect(pickTrack(tracks, "fr").baseUrl).toBe("b");
  expect(pickTrack([], "en")).toBe(null);
  expect(transcriptText('<transcript><text start="0" dur="1">Hello &amp;amp; welcome</text><text start="1">Hello &amp;amp; welcome</text><text start="2">to the show</text></transcript>'))
    .toBe("Hello & welcome to the show");
  expect(transcriptText('<timedtext><body><p t="0" d="1"><s>Rock</s><s> on</s></p></body></timedtext>')).toBe("Rock on");
});

test("a YouTube video: title, description and what is said in it", async () => {
  const yt = fetchMock.get("https://www.youtube.com");
  yt.intercept({ path: /^\/oembed\?/, method: "GET" }).reply(200, { title: "Coffee 101", author_name: "Bean TV" });
  yt.intercept({ path: "/watch?v=abcdefghijk", method: "GET" }).reply(200, '<script>ytcfg.set({"INNERTUBE_API_KEY": "KEY123"})</script>');
  let asked;
  yt.intercept({ path: "/youtubei/v1/player?key=KEY123", method: "POST" }).reply(200, (opts) => {
    asked = JSON.parse(opts.body);
    return {
      videoDetails: { title: "Coffee 101", author: "Bean TV", lengthSeconds: "754", viewCount: "12000", shortDescription: "How to brew." },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&fmt=srv3" }] } },
    };
  });
  yt.intercept({ path: "/api/timedtext?v=abcdefghijk&lang=en", method: "GET" }).reply(200, '<transcript><text start="0">Grind fresh.</text><text start="2">Water at 93 degrees.</text></transcript>');
  const read = await readLink("https://youtu.be/abcdefghijk", { language: "en" });
  expect(asked).toMatchObject({ videoId: "abcdefghijk", context: { client: { clientName: "ANDROID" } } });
  expect(read).toEqual({
    url: "https://youtu.be/abcdefghijk", kind: "youtube", title: "Coffee 101", author: "Bean TV",
    meta: "12:34, 12,000 views", text: "How to brew.", transcript: "Grind fresh. Water at 93 degrees.",
  });
});

test("a YouTube video whose player is refused still has its title", async () => {
  const yt = fetchMock.get("https://www.youtube.com");
  yt.intercept({ path: /^\/oembed\?/, method: "GET" }).reply(200, { title: "Coffee 101", author_name: "Bean TV" });
  yt.intercept({ path: "/watch?v=abcdefghijk", method: "GET" }).reply(429, "no");
  yt.intercept({ path: "/youtubei/v1/player", method: "POST" }).reply(403, {});
  const read = await readLink("https://www.youtube.com/watch?v=abcdefghijk");
  expect(read).toMatchObject({ kind: "youtube", title: "Coffee 101", author: "Bean TV", transcript: "" });
  expect(linksBlock([read])).toContain("Transcript: not available");
});

test("a TikTok: its caption and who posted it", async () => {
  fetchMock.get("https://www.tiktok.com").intercept({ path: /^\/oembed\?url=/, method: "GET" })
    .reply(200, { title: "Latte art in 10s #coffee", author_name: "Barista Ken", author_unique_id: "ken" });
  expect(await readLink("https://www.tiktok.com/@ken/video/7300000000000000000")).toMatchObject({
    kind: "tiktok", author: "Barista Ken @ken", text: "Latte art in 10s #coffee",
  });
});

test("a post on X: its text, author and numbers, by FxTwitter or else the embed", async () => {
  fetchMock.get("https://api.fxtwitter.com").intercept({ path: "/jack/status/20", method: "GET" }).reply(200, {
    code: 200,
    tweet: { text: "just setting up my twttr", author: { name: "jack", screen_name: "jack" }, created_at: "Tue Mar 21 20:50:14 +0000 2006", likes: 300000, retweets: 120000, replies: 10000, views: null },
  });
  const read = await readLink("https://x.com/jack/status/20?s=20");
  expect(read).toMatchObject({ kind: "x", author: "jack (@jack)", text: "just setting up my twttr" });
  expect(read.meta).toBe("Tue Mar 21 20:50:14 +0000 2006, 300000 likes, 120000 reposts, 10000 replies");

  fetchMock.get("https://api.fxtwitter.com").intercept({ path: "/jack/status/21", method: "GET" }).reply(404, { code: 404 });
  fetchMock.get("https://publish.twitter.com").intercept({ path: /^\/oembed\?/, method: "GET" })
    .reply(200, { author_name: "jack", html: "<blockquote><p>hello<br>world &amp; more</p></blockquote>" });
  expect(await readLink("https://twitter.com/jack/status/21")).toMatchObject({ kind: "x", author: "jack", text: "hello\nworld & more" });
});

test("any other page: Jina Reader's text, or the page's own when the reader cannot", async () => {
  fetchMock.get("https://r.jina.ai").intercept({ path: "/https://blog.example.com/a", method: "GET" })
    .reply(200, "Title: Pour-over guide\n\nURL Source: https://blog.example.com/a\n\nMarkdown Content:\n# Pour-over\nUse a 1:16 ratio.");
  expect(await readLink("https://blog.example.com/a")).toMatchObject({ kind: "page", title: "Pour-over guide", text: "# Pour-over\nUse a 1:16 ratio." });

  fetchMock.get("https://r.jina.ai").intercept({ path: "/https://shop.example.com/b", method: "GET" }).reply(429, "slow down");
  fetchMock.get("https://shop.example.com").intercept({ path: "/b", method: "GET" }).reply(200,
    '<html><head><title>Beans &amp; Co</title><meta name="description" content="Fresh beans"></head><body><script>x()</script><p>Ethiopia, 250g</p></body></html>',
    { headers: { "content-type": "text/html; charset=utf-8" } });
  expect(await readLink("https://shop.example.com/b")).toMatchObject({ kind: "page", title: "Beans & Co", text: "Fresh beans\nBeans & Co Ethiopia, 250g" });
});

test("what could not be read is left out, never thrown", async () => {
  fetchMock.get("https://r.jina.ai").intercept({ path: "/https://down.example.com/", method: "GET" }).replyWithError(new Error("boom"));
  fetchMock.get("https://down.example.com").intercept({ path: "/", method: "GET" }).reply(500, "x");
  expect(await readLinks(["https://down.example.com/", "http://localhost/x"])).toEqual([]);
  expect(linksBlock([])).toBe("");
});
