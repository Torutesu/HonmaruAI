import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: "test-db" },
        r2Buckets: ["MEDIA", "AUDIT_ARCHIVE"],
        // A fake Composio key so the relay Durable Object (reached via SELF)
        // has one in its OWN env — secrets are not injected into the DO
        // isolate otherwise, and the outbound-Notion write path needs it to
        // run at all. Only SELF-based tests see this; tests that call
        // worker.fetch pass their own env and win. Tests that must NOT reach
        // Composio register no interceptor, so a stray call throws.
        // Test-only audit keys, so every test writes the log the way
        // production does: each person under a key of their own.
        bindings: {
          COMPOSIO_API_KEY: "ak_test_relay",
          AUDIT_MASTER_KEY: "Qk16NjpxdRgOAokyadLTYJpxp/SpANl9tBELtbnSi8M=",
          // Ed25519, PKCS8: signs the archive's hourly digests.
          AUDIT_SIGNING_KEY: "MC4CAQAwBQYDK2VwBCIEINST0f2O7kgtKc+d9ltsB0U/u4JmkzAFJ8aDR129gou7",
          SSO_SECRET_KEY: "6pDBbf4ednHp34e7vEaE1q+QVMR9O7HyOxk1KrNi78U=",
          AUDIT_PSEUDONYM_KEY: "ln7/yH8WhNONheAGVvzq0ptYmGOdFxOJ3RInaq9stYY=",
        },
      },
    }),
  ],
  test: {
    // One file at a time. With one runtime per file in parallel, tearing one
    // file down aborted its open connections while another file was
    // mid-request, and the second file's results were lost with an "other
    // side closed" the test never saw. Sequential is slower and never loses
    // a file.
    fileParallelism: false,
    // The suite predates per-FILE storage isolation (0.22) and relies on
    // per-test isolation: setup.js resets storage and rebuilds the schema
    // before every test.
    setupFiles: ["./test/setup.js"],
  },
});
