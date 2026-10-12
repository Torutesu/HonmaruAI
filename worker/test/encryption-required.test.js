import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import worker from "../src/index.js";

// Encryption was optional: a Worker with no DATA_KEY stored secrets as they
// came, and without the audit keys wrote the log in the clear, and said
// nothing. Production now requires them.

const ask = (path, withEnv) => worker.fetch(new Request(`https://example.com${path}`), withEnv, { waitUntil() {} });

test("where encryption is required, a Worker without its keys serves nothing but /health, which says not ok", async () => {
  const bare = { ...env, REQUIRE_ENCRYPTION: "1", DATA_KEY: undefined };
  const health = await (await ask("/health", bare)).json();
  expect(health.ok).toBe(false);
  expect(health.encryption).toMatchObject({ data: false, audit: true, all: false });
  expect((await ask("/me", bare)).status).toBe(503);

  const keyed = { ...env, REQUIRE_ENCRYPTION: "1", DATA_KEY: btoa("k".repeat(32)) };
  expect((await (await ask("/health", keyed)).json())).toMatchObject({ ok: true, encryption: { all: true } });
  expect((await ask("/me", keyed)).status).toBe(401);
  // Elsewhere (development, staging) it is reported, not required.
  expect((await (await ask("/health", { ...env, DATA_KEY: undefined })).json()).ok).toBe(true);
});
