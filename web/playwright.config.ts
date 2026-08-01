import { defineConfig, devices } from "@playwright/test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8099;
const data = mkdtempSync(join(tmpdir(), "ttfw-e2e-"));

// Some sandboxes ship a Chromium that doesn't match this Playwright's pinned
// build. Use it when it's there rather than downloading a second one; CI
// installs its own and takes the default path.
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";

// The E2E suite drives the real relay serving the real build — same-origin,
// same session cookie, same socket as production. Only sign-in is swapped:
// DEV_AUTH replaces the GitHub round trip, which no CI can perform.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // On CI keep the console terse but leave a report behind to upload.
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: existsSync(PREINSTALLED_CHROMIUM)
      ? { executablePath: PREINSTALLED_CHROMIUM }
      : {},
  },
  webServer: {
    command: "node ../server/index.js",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    stdout: "ignore",
    env: {
      PORT: String(PORT),
      WEB_DIST_PATH: "../web/dist",
      DEV_AUTH: "true",
      // The suite runs over plain http, where Secure cookies never arrive.
      INSECURE_COOKIES: "true",
      OPENROUTER_API_KEY: "",
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      ESCALATION_INTERVAL_MINUTES: "0",
      CARDS_STORE_PATH: join(data, "cards.json"),
      CHANNELS_STORE_PATH: join(data, "channels.json"),
      ORG_STORE_PATH: join(data, "org.json"),
      PUSH_STORE_PATH: join(data, "push.json"),
      DIGEST_STORE_PATH: join(data, "digest.json"),
      MEMORY_STORE_PATH: join(data, "memory.json"),
      SESSIONS_STORE_PATH: join(data, "sessions.json"),
    },
  },
});
