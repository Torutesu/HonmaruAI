import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

test("GET /health reports readiness", async () => {
  const res = await SELF.fetch("https://example.com/health");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  // No AI keys in the test env, so routing reports the keyword fallback.
  expect(body.aiRouting).toBe(false);
  expect(body.aiModel).toBe("fallback");
  // Nothing here works without D1, and a check that only proves the Worker is
  // running proves the one thing the deploy already established.
  expect(body.database).toBe("ok");
});
