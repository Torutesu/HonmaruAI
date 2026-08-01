import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// /auth/dev hands out a session with no credentials. That is exactly what the
// browser E2E suite needs and exactly what must never be reachable by default,
// so the gate itself is what these tests cover.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.js");

function startServer(port, env = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "ttfw-devauth-"));
  return spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      CARDS_STORE_PATH: join(dataDir, "cards.json"),
      CHANNELS_STORE_PATH: join(dataDir, "channels.json"),
      ORG_STORE_PATH: join(dataDir, "org.json"),
      PUSH_STORE_PATH: join(dataDir, "push.json"),
      DIGEST_STORE_PATH: join(dataDir, "digest.json"),
      MEMORY_STORE_PATH: join(dataDir, "memory.json"),
      SESSIONS_STORE_PATH: join(dataDir, "sessions.json"),
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      OPENROUTER_API_KEY: "",
      ESCALATION_INTERVAL_MINUTES: "0",
      INSECURE_COOKIES: "true",
      ...env,
    },
    stdio: "ignore",
  });
}

async function waitForHealth(base, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Relay did not come up in time");
}

test("dev sign-in is absent unless it is explicitly turned on", async () => {
  const port = 18971;
  const base = `http://127.0.0.1:${port}`;
  const server = startServer(port);
  try {
    await waitForHealth(base);
    const response = await fetch(`${base}/auth/dev?user=user-bob`, { redirect: "manual" });
    assert.equal(response.status, 404);
    // And nothing is signed in as a side effect.
    assert.equal((await fetch(`${base}/auth/me`)).status, 401);
  } finally {
    server.kill("SIGKILL");
  }
});

test("dev sign-in stays off in production even when the flag is set", async () => {
  const port = 18972;
  const base = `http://127.0.0.1:${port}`;
  const server = startServer(port, { DEV_AUTH: "true", NODE_ENV: "production" });
  try {
    await waitForHealth(base);
    const response = await fetch(`${base}/auth/dev?user=user-bob`, { redirect: "manual" });
    assert.equal(response.status, 404);
  } finally {
    server.kill("SIGKILL");
  }
});

test("with DEV_AUTH on, it binds a session to a real org member", async () => {
  const port = 18973;
  const base = `http://127.0.0.1:${port}`;
  const server = startServer(port, { DEV_AUTH: "true" });
  try {
    await waitForHealth(base);

    const unknown = await fetch(`${base}/auth/dev?user=nobody`, { redirect: "manual" });
    assert.equal(unknown.status, 400);

    const response = await fetch(`${base}/auth/dev?user=user-bob`, { redirect: "manual" });
    assert.equal(response.status, 302);

    const cookie = response.headers.get("set-cookie") || "";
    assert.match(cookie, /ttfw_session=/);
    assert.match(cookie, /HttpOnly/);

    const me = await fetch(`${base}/auth/me`, {
      headers: { Cookie: cookie.split(";")[0] },
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, "user-bob");
  } finally {
    server.kill("SIGKILL");
  }
});
