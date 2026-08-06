import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { testConfig } from "./helpers.js";

async function json(app: App, path: string, options: RequestInit = {}) {
  const response = await app.http.request(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  return { status: response.status, body: await response.json() };
}

function authed(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("REST API", () => {
  let app: App;

  beforeEach(() => {
    app = createApp(testConfig());
  });

  async function login(name: string): Promise<string> {
    const { status, body } = await json(app, "/v1/auth/dev", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    expect(status).toBe(200);
    return body.token as string;
  }

  it("rejects requests without a token", async () => {
    const { status } = await json(app, "/v1/me");
    expect(status).toBe(401);
  });

  it("supports the full org + instruction + action flow", async () => {
    const aliceToken = await login("Alice");
    const bobToken = await login("Bob");

    const org = await json(app, "/v1/orgs", {
      method: "POST",
      headers: authed(aliceToken),
      body: JSON.stringify({ name: "Acme", title: "Product Manager" }),
    });
    expect(org.status).toBe(201);
    const orgId = org.body.org.id as string;

    const invite = await json(app, `/v1/orgs/${orgId}/invites`, {
      method: "POST",
      headers: authed(aliceToken),
      body: JSON.stringify({}),
    });
    expect(invite.status).toBe(201);

    const accept = await json(app, "/v1/invites/accept", {
      method: "POST",
      headers: authed(bobToken),
      body: JSON.stringify({ code: invite.body.code, title: "Engineer" }),
    });
    expect(accept.status).toBe(200);

    // Alice instructs; deterministic router should pick Bob (named).
    const instruction = await json(app, `/v1/orgs/${orgId}/instructions`, {
      method: "POST",
      headers: authed(aliceToken),
      body: JSON.stringify({ text: "tell Bob to fix the login bug urgently" }),
    });
    expect(instruction.status).toBe(201);
    const card = instruction.body.card;
    expect(card.status).toBe("pending");
    expect(card.priority).toBe("urgent");

    // Bob sees it in his feed.
    const bobCards = await json(app, `/v1/orgs/${orgId}/cards`, {
      headers: authed(bobToken),
    });
    expect(bobCards.body.cards.map((c: { id: string }) => c.id)).toContain(card.id);

    // Alice cannot approve her own outbound card.
    const forbidden = await json(app, `/v1/cards/${card.id}/actions`, {
      method: "POST",
      headers: authed(aliceToken),
      body: JSON.stringify({ action: "approve" }),
    });
    expect(forbidden.status).toBe(403);

    const approve = await json(app, `/v1/cards/${card.id}/actions`, {
      method: "POST",
      headers: authed(bobToken),
      body: JSON.stringify({ action: "approve" }),
    });
    expect(approve.status).toBe(200);
    expect(approve.body.card.status).toBe("approved");

    // Event log has member joins + card events, resumable by cursor.
    const events = await json(app, `/v1/orgs/${orgId}/events?sinceSeq=0`, {
      headers: authed(aliceToken),
    });
    const types = events.body.events.map((e: { type: string }) => e.type);
    expect(types).toContain("member_joined");
    expect(types).toContain("card_created");
    expect(types).toContain("card_updated");
  });

  it("keeps org data isolated between non-members", async () => {
    const aliceToken = await login("Alice");
    const malloryToken = await login("Mallory");
    const org = await json(app, "/v1/orgs", {
      method: "POST",
      headers: authed(aliceToken),
      body: JSON.stringify({ name: "Acme" }),
    });
    const orgId = org.body.org.id as string;

    const denied = await json(app, `/v1/orgs/${orgId}/cards`, {
      headers: authed(malloryToken),
    });
    expect(denied.status).toBe(403);
  });

  it("blocks dev login when dev mode is off", async () => {
    const prodApp = createApp(testConfig({ authDevMode: false }));
    const { status } = await json(prodApp, "/v1/auth/dev", {
      method: "POST",
      body: JSON.stringify({ name: "Alice" }),
    });
    expect(status).toBe(403);
  });

  it("redacts integration tokens and validates config", async () => {
    const aliceToken = await login("Alice");
    const org = await json(app, "/v1/orgs", {
      method: "POST",
      headers: authed(aliceToken),
      body: JSON.stringify({ name: "Acme" }),
    });
    const orgId = org.body.org.id as string;

    const badConfig = await json(app, `/v1/orgs/${orgId}/integrations/github_issues`, {
      method: "PUT",
      headers: authed(aliceToken),
      body: JSON.stringify({ enabled: true, config: { repo: "not-a-repo" } }),
    });
    expect(badConfig.status).toBe(400);

    const saved = await json(app, `/v1/orgs/${orgId}/integrations/github_issues`, {
      method: "PUT",
      headers: authed(aliceToken),
      body: JSON.stringify({
        enabled: true,
        config: { repo: "acme/app", token: "ghp_secret" },
      }),
    });
    expect(saved.status).toBe(200);

    const list = await json(app, `/v1/orgs/${orgId}/integrations`, {
      headers: authed(aliceToken),
    });
    expect(list.body.integrations[0].config.token).toBe("•••");
  });
});
