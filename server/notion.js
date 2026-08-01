// Notion, connected for real — not just recognised in a URL.
//
// Two jobs. First, a Notion link inside an instruction stops being a bare
// "Notion" chip and becomes the page's actual title. Second, a card with no
// links at all gets the relevant page found for it: the AI searches the
// workspace with the decision's own words and staples on what it finds.
//
// The integration token lives here, server-side, exactly like the GitHub
// token — the browser only ever sees a title, an excerpt and a URL.
//
// Everything is best-effort. Notion being slow, rate-limited, unreachable or
// simply not configured must never delay or fail a decision: the card ships
// with whatever provenance it already had.

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

const HEX32 = /[0-9a-f]{32}/i;

/** Notion URLs end in a 32-hex id, usually glued to a slugified title. */
export function notionPageIdFromUrl(url) {
  const raw = String(url || "");
  if (!/notion\.(so|site)/i.test(raw)) return null;

  let path;
  try {
    path = new URL(raw).pathname + new URL(raw).search;
  } catch {
    return null;
  }

  // ?p= / &p= carries the id on database views; otherwise it's in the path.
  const match = path.match(HEX32);
  if (!match) return null;

  const id = match[0].toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

const richText = (items) =>
  (Array.isArray(items) ? items : []).map((item) => item?.plain_text || "").join("");

/** The title property is named by the workspace, so find it by type. */
export function pageTitle(page) {
  const properties = page?.properties || {};
  for (const value of Object.values(properties)) {
    if (value?.type === "title") {
      const text = richText(value.title).trim();
      if (text) return text;
    }
  }
  // Databases carry their name at the top level instead.
  const fallback = richText(page?.title).trim();
  return fallback || "Untitled";
}

const BLOCK_PREFIX = {
  heading_1: "# ",
  heading_2: "## ",
  heading_3: "### ",
  bulleted_list_item: "• ",
  numbered_list_item: "• ",
  to_do: "☐ ",
  quote: "> ",
};

/** Blocks → a readable excerpt. Enough to decide from, not a full mirror. */
export function blocksToText(blocks, { maxChars = 1200 } = {}) {
  const lines = [];

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const type = block?.type;
    const body = block?.[type];
    if (!body) continue;

    const text = richText(body.rich_text).trim();
    if (!text) continue;

    const prefix =
      type === "to_do" ? (body.checked ? "☑ " : "☐ ") : BLOCK_PREFIX[type] || "";
    lines.push(prefix + text);

    if (lines.join("\n").length > maxChars) break;
  }

  const joined = lines.join("\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars).trimEnd()}…` : joined;
}

// Words that match everything and therefore mean nothing in a search.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "to", "of", "in", "on", "at", "by",
  "with", "from", "into", "before", "after", "is", "are", "be", "been", "we", "our",
  "you", "your", "it", "this", "that", "these", "those", "needs", "need", "please",
  "approve", "approval", "review", "decide", "decision", "card", "update", "new",
]);

const tokenize = (text) =>
  String(text || "")
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9぀-ヿ一-龯]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));

/** The decision's own words, minus the words every decision contains. */
export function searchQuery(card, { maxTerms = 8 } = {}) {
  const seen = new Set();
  const terms = [];
  for (const word of [...tokenize(card?.title), ...tokenize(card?.summary)]) {
    if (seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
    if (terms.length >= maxTerms) break;
  }
  return terms.join(" ");
}

/**
 * How much of the query the page title actually covers. Notion's search is
 * generous — it will happily return the workspace's front page for anything —
 * so a weak match is worse than no source at all.
 */
export function scoreMatch(query, title) {
  const wanted = tokenize(query);
  if (wanted.length === 0) return 0;
  const found = new Set(tokenize(title));
  const hits = wanted.filter((word) => found.has(word)).length;
  return hits / wanted.length;
}

export const MIN_MATCH_SCORE = 0.34;

async function request(token, path, { baseUrl = API, method = "GET", body, timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": VERSION,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Notion client. Every method resolves to null or [] rather than throwing —
 * callers sit on the card delivery path and must not be able to break it.
 */
export function createNotion({ token, baseUrl = API } = {}) {
  const configured = Boolean(token);

  return {
    configured,

    async page(pageID) {
      if (!configured || !pageID) return null;
      const page = await request(token, `/pages/${pageID}`, { baseUrl });
      if (!page) return null;
      return { id: page.id, title: pageTitle(page), url: page.url || null };
    },

    async excerpt(pageID) {
      if (!configured || !pageID) return "";
      const blocks = await request(token, `/blocks/${pageID}/children?page_size=50`, { baseUrl });
      return blocksToText(blocks?.results);
    },

    async search(query, { limit = 3 } = {}) {
      if (!configured || !query) return [];
      const result = await request(token, "/search", {
        baseUrl,
        method: "POST",
        body: {
          query,
          filter: { value: "page", property: "object" },
          page_size: limit,
        },
      });
      return (result?.results || [])
        .filter((page) => page?.object === "page" && page.url)
        .map((page) => ({ id: page.id, title: pageTitle(page), url: page.url }));
    },
  };
}

const MAX_ATTACHED = 2;
/** A card whose chip row needs scrolling has stopped being a summary. */
const MAX_TOTAL = 5;

/**
 * Turn a card's sources into real Notion knowledge: name the pages it already
 * links to, and — when it links to none — find the page it is about.
 *
 * Returns a new array; the caller keeps whatever it had if nothing improves.
 */
export async function resolveNotionSources({ card, sources = [], notion }) {
  if (!notion?.configured) return sources;

  const resolved = [];
  let sawNotion = false;

  for (const source of sources) {
    const pageID = notionPageIdFromUrl(source.url);
    if (!pageID) {
      resolved.push(source);
      continue;
    }
    sawNotion = true;

    const page = await notion.page(pageID);
    // A page the integration can't see stays a plain link rather than vanishing.
    resolved.push(
      page
        ? { ...source, kind: "doc", label: page.title, notionPageID: pageID }
        : source
    );
  }

  if (sawNotion) return resolved.slice(0, MAX_TOTAL);

  const query = searchQuery(card);
  if (!query) return resolved;

  const linked = new Set(resolved.map((source) => source.url).filter(Boolean));
  const hits = await notion.search(query);

  for (const hit of hits) {
    if (resolved.length - sources.length >= MAX_ATTACHED) break;
    if (linked.has(hit.url)) continue;
    // A vague match is worse than no source: it teaches people to distrust the chip.
    if (scoreMatch(query, hit.title) < MIN_MATCH_SCORE) continue;

    resolved.push({
      kind: "doc",
      label: hit.title,
      url: hit.url,
      notionPageID: hit.id,
    });
  }

  return resolved.slice(0, MAX_TOTAL);
}
