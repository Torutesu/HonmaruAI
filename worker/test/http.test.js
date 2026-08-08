import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

test("GET /health reports readiness", async () => {
  const res = await SELF.fetch("https://example.com/health");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.aiModel).toBe("gpt-4o-mini");
});
