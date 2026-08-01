import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  blocksToText,
  createNotion,
  MIN_MATCH_SCORE,
  notionPageIdFromUrl,
  pageTitle,
  resolveNotionSources,
  scoreMatch,
  searchQuery,
} from "../notion.js";

const card = (overrides = {}) => ({
  id: "card-1",
  title: "Approve the onboarding rewrite",
  summary: "The onboarding flow rewrite needs sign-off before the Friday release.",
  ...overrides,
});

test("extracts the page id from the shapes Notion actually produces", () => {
  const id = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
  const dashed = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";

  assert.equal(notionPageIdFromUrl(`https://www.notion.so/team/Onboarding-${id}`), dashed);
  assert.equal(notionPageIdFromUrl(`https://notion.so/${id}`), dashed);
  // Database views carry the page in a query parameter.
  assert.equal(notionPageIdFromUrl(`https://www.notion.so/team/Board?p=${id}&pvs=4`), dashed);
  assert.equal(notionPageIdFromUrl(`https://acme.notion.site/Specs-${id.toUpperCase()}`), dashed);

  assert.equal(notionPageIdFromUrl("https://github.com/acme/app/pull/12"), null);
  assert.equal(notionPageIdFromUrl("https://www.notion.so/team/no-id-here"), null);
  assert.equal(notionPageIdFromUrl(""), null);
  assert.equal(notionPageIdFromUrl(undefined), null);
});

test("finds the title however the workspace named the property", () => {
  assert.equal(
    pageTitle({ properties: { "Doc name": { type: "title", title: [{ plain_text: "Q3 plan" }] } } }),
    "Q3 plan"
  );
  // Databases put their name at the top level instead of in properties.
  assert.equal(pageTitle({ title: [{ plain_text: "Roadmap" }] }), "Roadmap");
  assert.equal(pageTitle({}), "Untitled");
});

test("renders blocks as a readable excerpt and stops at the cap", () => {
  const text = blocksToText([
    { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Decision" }] } },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Ship on Friday." }] } },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Copy final" }] } },
    { type: "to_do", to_do: { rich_text: [{ plain_text: "Legal review" }], checked: true } },
    { type: "image", image: {} }, // no text — skipped, not rendered as a blank line
    { type: "paragraph", paragraph: { rich_text: [] } },
  ]);

  assert.equal(text, "# Decision\nShip on Friday.\n• Copy final\n☑ Legal review");

  const long = blocksToText(
    [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "x".repeat(500) }] } }],
    { maxChars: 100 }
  );
  assert.ok(long.endsWith("…"));
  assert.ok(long.length <= 101);
});

test("the search query is the decision's own words, minus boilerplate", () => {
  const query = searchQuery(card());
  // "approve" / "needs" / "the" appear in every card and would match everything.
  assert.ok(!query.includes("approve"));
  assert.ok(!query.includes("needs"));
  assert.ok(query.includes("onboarding"));
  assert.equal(searchQuery({ title: "Please approve", summary: "" }), "");
});

test("a vague match scores below the bar", () => {
  const query = searchQuery(card());
  assert.ok(scoreMatch(query, "Onboarding rewrite — flow spec") >= MIN_MATCH_SCORE);
  assert.ok(scoreMatch(query, "Company wiki home") < MIN_MATCH_SCORE);
  assert.equal(scoreMatch("", "anything"), 0);
});

test("without a token nothing is attached and nothing is called", () => {
  const notion = createNotion({});
  assert.equal(notion.configured, false);

  const sources = [{ kind: "channel", label: "#general", channelID: "channel-1" }];
  return resolveNotionSources({ card: card(), sources, notion }).then((resolved) => {
    assert.deepEqual(resolved, sources);
  });
});

// A stub standing in for the API: the client's own request layer is thin, the
// decisions worth testing are which pages get attached and how they're labelled.
function stubNotion({ pages = {}, hits = [] } = {}) {
  const calls = { pages: [], searches: [] };
  return {
    calls,
    notion: {
      configured: true,
      async page(id) {
        calls.pages.push(id);
        return pages[id] ?? null;
      },
      async search(query) {
        calls.searches.push(query);
        return hits;
      },
      async excerpt() {
        return "";
      },
    },
  };
}

const PAGE_ID = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
const PAGE_URL = "https://www.notion.so/team/Onboarding-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

test("a linked Notion page becomes its real title", async () => {
  const { notion } = stubNotion({
    pages: { [PAGE_ID]: { id: PAGE_ID, title: "Onboarding rewrite spec", url: PAGE_URL } },
  });

  const resolved = await resolveNotionSources({
    card: card(),
    sources: [{ kind: "link", label: "Notion", url: PAGE_URL }],
    notion,
  });

  assert.deepEqual(resolved, [
    { kind: "doc", label: "Onboarding rewrite spec", url: PAGE_URL, notionPageID: PAGE_ID },
  ]);
});

test("a page the integration can't see stays a plain link", async () => {
  const { notion } = stubNotion({ pages: {} });

  const resolved = await resolveNotionSources({
    card: card(),
    sources: [{ kind: "link", label: "Notion", url: PAGE_URL }],
    notion,
  });

  assert.deepEqual(resolved, [{ kind: "link", label: "Notion", url: PAGE_URL }]);
});

test("a card that links nothing gets the page it is about found for it", async () => {
  const { notion, calls } = stubNotion({
    hits: [
      { id: "page-a", title: "Onboarding rewrite — flow spec", url: "https://notion.so/a" },
      { id: "page-b", title: "Company wiki home", url: "https://notion.so/b" },
    ],
  });

  const resolved = await resolveNotionSources({
    card: card(),
    sources: [{ kind: "channel", label: "#general", channelID: "channel-1" }],
    notion,
  });

  assert.equal(calls.searches.length, 1);
  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved[1], {
    kind: "doc",
    label: "Onboarding rewrite — flow spec",
    url: "https://notion.so/a",
    notionPageID: "page-a",
  });
  // The wiki home matches everything and is therefore attached to nothing.
  assert.ok(!resolved.some((source) => source.label === "Company wiki home"));
});

test("an explicitly linked page suppresses the search entirely", async () => {
  const { notion, calls } = stubNotion({
    pages: { [PAGE_ID]: { id: PAGE_ID, title: "Onboarding rewrite spec", url: PAGE_URL } },
    hits: [{ id: "page-a", title: "Onboarding rewrite plan", url: "https://notion.so/a" }],
  });

  await resolveNotionSources({
    card: card(),
    sources: [{ kind: "link", label: "Notion", url: PAGE_URL }],
    notion,
  });

  // The human already said which page matters; guessing more is noise.
  assert.equal(calls.searches.length, 0);
});

test("the chip row stays a summary — sources are capped", async () => {
  const { notion } = stubNotion({
    hits: Array.from({ length: 5 }, (_, index) => ({
      id: `page-${index}`,
      title: `Onboarding rewrite variant ${index}`,
      url: `https://notion.so/${index}`,
    })),
  });

  const resolved = await resolveNotionSources({
    card: card(),
    sources: [
      { kind: "channel", label: "#general", channelID: "channel-1" },
      { kind: "link", label: "PR #12", url: "https://github.com/acme/app/pull/12" },
      { kind: "link", label: "Figma", url: "https://figma.com/file/1" },
      { kind: "link", label: "Linear", url: "https://linear.app/x" },
    ],
    notion,
  });

  assert.ok(resolved.length <= 5);
});

// The stubbed-client tests above cover which sources get attached. These
// cover the wire itself — headers, paths, payload shape, and what happens
// when Notion answers with something other than 200.

function fakeNotion(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : null,
    });
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        requests,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    );
  });
}

const json = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

test("the client speaks the API Notion actually publishes", async () => {
  const fake = await fakeNotion((req, res) => {
    if (req.url.startsWith("/pages/")) {
      return json(res, 200, {
        id: PAGE_ID,
        url: PAGE_URL,
        properties: { Name: { type: "title", title: [{ plain_text: "Onboarding spec" }] } },
      });
    }
    if (req.url.startsWith("/blocks/")) {
      return json(res, 200, {
        results: [
          { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Ship on Friday." }] } },
        ],
      });
    }
    if (req.url === "/search") {
      return json(res, 200, {
        results: [
          { object: "page", id: "p1", url: "https://notion.so/p1", properties: {} },
          { object: "database", id: "d1", url: "https://notion.so/d1" }, // filtered out
          { object: "page", id: "p2" }, // no url — unusable, filtered out
        ],
      });
    }
    return json(res, 404, {});
  });

  try {
    const notion = createNotion({ token: "secret_abc", baseUrl: fake.baseUrl });

    const page = await notion.page(PAGE_ID);
    assert.deepEqual(page, { id: PAGE_ID, title: "Onboarding spec", url: PAGE_URL });

    assert.equal(await notion.excerpt(PAGE_ID), "Ship on Friday.");

    const hits = await notion.search("onboarding rewrite");
    assert.deepEqual(hits, [{ id: "p1", title: "Untitled", url: "https://notion.so/p1" }]);

    const [pageCall, blockCall, searchCall] = fake.requests;
    assert.equal(pageCall.headers.authorization, "Bearer secret_abc");
    // Notion rejects requests without a pinned version — silently in some cases.
    assert.equal(pageCall.headers["notion-version"], "2022-06-28");
    assert.equal(blockCall.url, `/blocks/${PAGE_ID}/children?page_size=50`);
    assert.equal(searchCall.method, "POST");
    assert.deepEqual(searchCall.body, {
      query: "onboarding rewrite",
      filter: { value: "page", property: "object" },
      page_size: 3,
    });
  } finally {
    await fake.close();
  }
});

test("an unhappy Notion degrades to nothing, never to a thrown card", async () => {
  const fake = await fakeNotion((req, res) => {
    if (req.url === "/search") return json(res, 429, { message: "rate limited" });
    return res.destroy(); // connection dropped mid-flight
  });

  try {
    const notion = createNotion({ token: "secret_abc", baseUrl: fake.baseUrl });

    assert.equal(await notion.page(PAGE_ID), null);
    assert.equal(await notion.excerpt(PAGE_ID), "");
    assert.deepEqual(await notion.search("anything"), []);

    // And the delivery path keeps the sources it already had.
    const sources = [{ kind: "channel", label: "#general", channelID: "channel-1" }];
    assert.deepEqual(await resolveNotionSources({ card: card(), sources, notion }), sources);
  } finally {
    await fake.close();
  }
});
