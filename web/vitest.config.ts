import { defineConfig } from "vitest/config";

// Vitest owns src/**; e2e/ belongs to Playwright, which brings its own runner
// and a real browser. The suites here are plain TS — no JSX transform needed.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
