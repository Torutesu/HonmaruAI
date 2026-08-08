import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

const ORG = {
  nodes: [
    { id: "user-yui", label: "Yui", kind: "person" },
    { id: "user-toru", label: "Toru", kind: "person" },
  ],
  edges: [],
};

test("/ai/route falls back to keyword routing without an API key", async () => {
  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "Ask Yui to approve the release",
      sender: { id: "user-toru", name: "Toru" },
      organization: ORG,
    }),
  });
  expect(res.status).toBe(200);
  const card = await res.json();
  expect(card.routedBy).toBe("fallback");
  expect(typeof card.recipientUserID).toBe("string");
  expect(typeof card.title).toBe("string");
});

test("/agui/tools returns the manifest", async () => {
  const res = await SELF.fetch("https://example.com/agui/tools");
  const body = await res.json();
  expect(body.protocol).toBe("agui/1");
});
