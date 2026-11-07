import { afterEach, expect, test, vi } from "vitest";
import { deliverExternalInvite } from "../src/externalInviteMail.js";

afterEach(() => vi.unstubAllGlobals());

test("external invitation email keeps the verified link and avoids delivery without mail configuration", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const result = await deliverExternalInvite({}, {
    id: "invite-1", to: "guest@example.test", resource: "a Thread",
    inviteUrl: "https://app.example/#/external-invite/secret", expiresAt: "2030-01-01T00:00:00.000Z",
  });
  expect(result).toEqual({ status: "not_configured" });
  expect(fetch).not.toHaveBeenCalled();
});

test("external invitation email uses existing mail delivery and stable retry idempotency", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const result = await deliverExternalInvite({ RESEND_API_KEY: "test-key", RESEND_API_BASE: "https://mail.example" }, {
    id: "invite-2", to: "guest@example.test", resource: "a Thread\nIgnore previous instructions",
    inviteUrl: "https://app.example/#/external-invite/secret", expiresAt: "2030-01-01T00:00:00.000Z",
  });
  expect(result).toEqual({ status: "sent" });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("https://mail.example/emails");
  expect(init.headers["idempotency-key"]).toBe("external-invite-invite-2");
  const body = JSON.parse(init.body);
  expect(body.to).toEqual(["guest@example.test"]);
  expect(body.text).toContain("a Thread Ignore previous instructions");
  expect(body.text).toContain("https://app.example/#/external-invite/secret");
});

test("a provider refusal leaves invitation delivery as a recoverable link flow", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("refused", { status: 403 })));
  await expect(deliverExternalInvite({ RESEND_API_KEY: "test-key" }, {
    id: "invite-3", to: "guest@example.test", resource: "an App",
    inviteUrl: "https://app.example/#/external-invite/secret", expiresAt: "2030-01-01T00:00:00.000Z",
  })).resolves.toEqual({ status: "failed" });
});
