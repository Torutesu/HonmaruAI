import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import worker from "../src/index.js";

// A request that throws past every route still answers like the rest of the
// API: JSON, with the CORS headers, so the web app can read it. Without them
// the browser hid the response and the app said it could not reach the
// server, when the server was answering.

const failing = (message) => ({ ...env, DB: { prepare() { throw new Error(message); } } });
const me = (e) => worker.fetch(
  new Request("https://example.com/me", { headers: { "x-session-token": "t", origin: "https://app.example.com" } }),
  e,
  { waitUntil() {} },
);

test("an unexpected error is a 500 the browser can read", async () => {
  const res = await me(failing("something broke"));
  expect(res.status).toBe(500);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("x-request-id")).toBeTruthy();
  expect(await res.json()).toMatchObject({ message: "Something went wrong on our side." });
});

test("D1 past its free tier's daily rows is a 503 that says the service is unavailable", async () => {
  const res = await me(failing("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."));
  expect(res.status).toBe(503);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(await res.json()).toMatchObject({ code: "service-unavailable" });
});
