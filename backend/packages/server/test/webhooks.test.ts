import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { setExternalRef } from "../src/cards.js";
import { handleGitHubEvent, verifyGitHubSignature } from "../src/webhooks.js";
import { testConfig } from "./helpers.js";

const SECRET = "hook-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

async function json(app: App, path: string, options: RequestInit = {}) {
  const response = await app.http.request(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

describe("GitHub webhook reverse sync", () => {
  let app: App;
  let orgId: string;
  let cardId: string;
  let aliceToken: string;
  const issueUrl = "https://github.com/acme/app/issues/42";

  beforeEach(async () => {
    app = createApp(
      testConfig({
        github: {
          clientId: "",
          clientSecret: "",
          redirectUri: "",
          webhookSecret: SECRET,
        },
      })
    );
    const login = async (name: string) =>
      (
        await json(app, "/v1/auth/dev", { method: "POST", body: JSON.stringify({ name }) })
      ).body.token as string;
    aliceToken = await login("Alice");
    const bobToken = await login("Bob");
    const org = await json(app, "/v1/orgs", {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ name: "Acme" }),
    });
    orgId = org.body.org.id;
    const invite = await json(app, `/v1/orgs/${orgId}/invites`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({}),
    });
    await json(app, "/v1/invites/accept", {
      method: "POST",
      headers: { Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ code: invite.body.code, title: "Engineer" }),
    });
    const card = await json(app, `/v1/orgs/${orgId}/instructions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ text: "tell Bob to fix the login bug" }),
    });
    cardId = card.body.card.id;
    await json(app, `/v1/cards/${cardId}/actions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ action: "approve" }),
    });
    // Simulate the integration having mirrored the card to an issue.
    setExternalRef(app.db, cardId, {
      integration: "github_issues",
      externalId: "42",
      url: issueUrl,
      state: "open",
    });
  });

  function issueEvent(action: string) {
    return JSON.stringify({
      action,
      issue: { number: 42, html_url: issueUrl },
    });
  }

  it("rejects bad signatures and verifies good ones", async () => {
    const body = issueEvent("closed");
    expect(verifyGitHubSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyGitHubSignature(body, "sha256=deadbeef", SECRET)).toBe(false);

    const bad = await json(app, "/v1/webhooks/github", {
      method: "POST",
      headers: { "X-Hub-Signature-256": "sha256=deadbeef", "X-GitHub-Event": "issues" },
      body,
    });
    expect(bad.status).toBe(401);
  });

  it("issue closed completes the card and notifies both parties", async () => {
    const body = issueEvent("closed");
    const response = await json(app, "/v1/webhooks/github", {
      method: "POST",
      headers: { "X-Hub-Signature-256": sign(body), "X-GitHub-Event": "issues" },
      body,
    });
    expect(response.status).toBe(200);
    expect(response.body.handled).toBe(true);

    const cards = await json(app, `/v1/orgs/${orgId}/cards`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const card = cards.body.cards.find((c: { id: string }) => c.id === cardId);
    expect(card.status).toBe("completed");
    expect(card.externalRefs[0].state).toBe("closed");

    const inbox = await json(app, `/v1/orgs/${orgId}/notifications`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(
      inbox.body.notifications.some((n: { title: string }) =>
        n.title.includes("closed on GitHub")
      )
    ).toBe(true);
  });

  it("issue reopened re-activates a completed card; unknown issues are no-ops", async () => {
    const closed = issueEvent("closed");
    await json(app, "/v1/webhooks/github", {
      method: "POST",
      headers: { "X-Hub-Signature-256": sign(closed), "X-GitHub-Event": "issues" },
      body: closed,
    });
    const reopened = issueEvent("reopened");
    await json(app, "/v1/webhooks/github", {
      method: "POST",
      headers: { "X-Hub-Signature-256": sign(reopened), "X-GitHub-Event": "issues" },
      body: reopened,
    });
    const cards = await json(app, `/v1/orgs/${orgId}/cards`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const card = cards.body.cards.find((c: { id: string }) => c.id === cardId);
    expect(card.status).toBe("approved");

    expect(
      handleGitHubEvent(app.db, "issues", {
        action: "closed",
        issue: { number: 99, html_url: "https://github.com/acme/app/issues/99" },
      })
    ).toBeNull();
  });
});
