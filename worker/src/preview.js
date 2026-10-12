/// A link's card, the way chat apps unfurl one: its title, a line of what
/// it is, a picture, the site — and for a video, what it takes to play it
/// in place. Read from the page's own Open Graph tags; YouTube and TikTok
/// from their oEmbed; a post on X from FxTwitter. Kept a day in the cache,
/// so a link said in a busy channel is read once.

import { isPublicUrl, classifyLink, publicFetch } from "./links.js";

const TIMEOUT_MS = 6000;
const MAX_HTML = 400_000;
const TTL_S = 24 * 3600;
const UA = "Mozilla/5.0 (compatible; HonmaruBot/1.0; +https://app.honmaruai.com)";

const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function decode(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/// The <meta> tags of a page's head, by property or name.
export function metaOf(html) {
  const head = String(html).slice(0, MAX_HTML);
  const out = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const value = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && value !== undefined && !(key.toLowerCase() in out)) out[key.toLowerCase()] = decode(value);
  }
  out.__title = decode((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  out.__icon = (head.match(/<link\b[^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/i) || [""])[0].match(/href=["']([^"']+)["']/i)?.[1] || "";
  return out;
}

const absolute = (value, base) => {
  if (!value) return null;
  try {
    const u = new URL(value, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch { return null; }
};

async function pageCard(url) {
  let res;
  let finalUrl;
  try {
    ({ res, url: finalUrl } = await publicFetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(TIMEOUT_MS) }));
  } catch { return null; }
  if (!res.ok || !/html/i.test(res.headers.get("content-type") || "")) return null;
  const html = (await res.text()).slice(0, MAX_HTML);
  const m = metaOf(html);
  const title = m["og:title"] || m["twitter:title"] || m.__title;
  if (!title) return null;
  return {
    kind: "page",
    title: clip(title, 140),
    description: clip(m["og:description"] || m["twitter:description"] || m.description, 280),
    image: absolute(m["og:image"] || m["og:image:url"] || m["twitter:image"] || m["twitter:image:src"], finalUrl),
    site: clip(m["og:site_name"] || new URL(finalUrl).hostname.replace(/^www\./, ""), 60),
    icon: absolute(m.__icon || "/favicon.ico", finalUrl),
  };
}

async function youtubeCard(url, id) {
  const embed = await getJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`);
  return {
    kind: "youtube",
    videoId: id,
    title: clip(embed?.title || "YouTube", 140),
    description: clip(embed?.author_name || "", 120),
    image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    site: "YouTube",
    icon: "https://www.youtube.com/favicon.ico",
  };
}

async function tiktokCard(url) {
  const embed = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
  if (!embed) return null;
  return {
    kind: "tiktok",
    title: clip(embed.title || "TikTok", 140),
    description: clip(embed.author_name || "", 120),
    image: embed.thumbnail_url || null,
    site: "TikTok",
    icon: "https://www.tiktok.com/favicon.ico",
  };
}

async function postCard(url, { user, id }) {
  const data = await getJson(`https://api.fxtwitter.com/${encodeURIComponent(user)}/status/${id}`);
  const tweet = data?.tweet;
  if (!tweet) return null;
  const photo = (tweet.media?.photos || [])[0]?.url || (tweet.media?.videos || [])[0]?.thumbnail_url || null;
  return {
    kind: "x",
    title: clip(`${tweet.author?.name || user} (@${tweet.author?.screen_name || user})`, 140),
    description: clip(tweet.text || tweet.article?.title || "", 280),
    image: photo,
    site: "X",
    icon: "https://abs.twimg.com/favicons/twitter.3.ico",
  };
}

/// The card for one link, or null when there is nothing worth showing.
export async function previewOf(url) {
  if (!isPublicUrl(url)) return null;
  const link = classifyLink(url);
  if (link.kind === "youtube") return youtubeCard(url, link.id);
  if (link.kind === "tiktok") return (await tiktokCard(url)) || pageCard(url);
  if (link.kind === "x") return (await postCard(url, link)) || pageCard(url);
  return pageCard(url);
}

/// previewOf, kept a day in the edge cache.
export async function cachedPreview(url, ctx) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(`https://preview.cache/${encodeURIComponent(url)}`);
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) return hit.json();
  }
  const card = await previewOf(url).catch(() => null);
  const body = { url, card };
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": `max-age=${card ? TTL_S : 3600}` } })).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return body;
}
