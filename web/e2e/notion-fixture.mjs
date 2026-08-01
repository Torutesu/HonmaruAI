import { createServer } from "node:http";

// A stand-in Notion workspace for the E2E suite. The relay talks to it through
// its real HTTP client (NOTION_API_BASE), so everything between the browser and
// the Notion wire format is genuinely exercised — only Notion's servers are
// swapped out, because CI has no workspace to point at.

const PORT = Number(process.env.PORT || 8098);

const PAGE_ID = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";

const PAGE = {
  id: PAGE_ID,
  url: "https://www.notion.so/team/Onboarding-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  properties: {
    Name: { type: "title", title: [{ plain_text: "Onboarding rewrite spec" }] },
  },
};

const BLOCKS = {
  results: [
    { type: "heading_2", heading_2: { rich_text: [{ plain_text: "Scope" }] } },
    {
      type: "paragraph",
      paragraph: { rich_text: [{ plain_text: "Three screens, no new backend work." }] },
    },
    { type: "to_do", to_do: { rich_text: [{ plain_text: "Legal sign-off" }], checked: true } },
  ],
};

const send = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

createServer((req, res) => {
  if (req.url === "/health") return send(res, 200, { ok: true });
  if (req.url.startsWith("/pages/")) return send(res, 200, PAGE);
  if (req.url.startsWith("/blocks/")) return send(res, 200, BLOCKS);
  if (req.url === "/search") {
    // Consume the body so the client's POST completes cleanly.
    req.resume();
    return req.on("end", () => send(res, 200, { results: [{ ...PAGE, object: "page" }] }));
  }
  return send(res, 404, { message: "not found" });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Notion fixture on http://127.0.0.1:${PORT}`);
});
