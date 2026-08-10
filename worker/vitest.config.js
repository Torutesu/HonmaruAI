import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { DB: "test-db" },
          r2Buckets: ["MEDIA"],
          // A fake Composio key so the relay Durable Object (reached via SELF)
          // has one in its OWN env — secrets are not injected into the DO
          // isolate otherwise, and the outbound-Notion write path needs it to
          // run at all. Only SELF-based tests see this; tests that call
          // worker.fetch pass their own env and win. Tests that must NOT reach
          // Composio register no interceptor, so a stray call throws.
          bindings: { COMPOSIO_API_KEY: "ak_test_relay" },
        },
      },
    },
  },
});
