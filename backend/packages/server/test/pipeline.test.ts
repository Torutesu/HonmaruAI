import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type App } from "../src/app.js";
import { testConfig } from "./helpers.js";

// End-to-end test of the two-phase instruction pipeline through the REST
// surface: fast local routing responds immediately, then the LLM
// refinement job upgrades (and possibly re-routes) the card.

async function json(app: App, path: string, options: RequestInit = {}) {
  const response = await app.http.request(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

function openRouterResponse(args: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "create_decision_card",
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
        },
      ],
    }),
  } as Response;
}

async function setupOrg(app: App) {
  const login = async (name: string) =>
    (
      await json(app, "/v1/auth/dev", {
        method: "POST",
        body: JSON.stringify({ name }),
      })
    ).body.token as string;
  const aliceToken = await login("Alice");
  const bobToken = await login("Bob");
  const carolToken = await login("Carol");
  const org = await json(app, "/v1/orgs", {
    method: "POST",
    headers: { Authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify({ name: "Acme", title: "PM" }),
  });
  const orgId = org.body.org.id as string;
  for (const [token, title] of [
    [bobToken, "Engineer"],
    [carolToken, "Designer"],
  ] as const) {
    const invite = await json(app, `/v1/orgs/${orgId}/invites`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({}),
    });
    await json(app, "/v1/invites/accept", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: invite.body.code, title }),
    });
  }
  const members = await json(app, `/v1/orgs/${orgId}`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  const byName = Object.fromEntries(
    members.body.members.map((m: { name: string; userId: string }) => [
      m.name,
      m.userId,
    ])
  ) as Record<string, string>;
  return { aliceToken, bobToken, carolToken, orgId, byName };
}

describe("two-phase instruction pipeline", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("responds from the fast path, then AI refinement re-routes the card", async () => {
    const app = createApp(
      testConfig({
        openRouter: {
          apiKey: "test",
          model: "test-model",
          appName: "t",
          appUrl: "t",
        },
      })
    );
    const { aliceToken, orgId, byName } = await setupOrg(app);

    const realFetch = globalThis.fetch;
    let llmCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("openrouter.ai")) {
        llmCalls += 1;
        // The model disagrees with keyword routing: this is design work.
        return openRouterResponse({
          recipientUserId: byName.Carol,
          cardType: "task",
          title: "Redesign empty state",
          summary: "Carol should redesign the onboarding empty state.",
          context: "surface: onboarding · deadline: Friday",
          priority: "medium",
          routingReason: "Design ownership",
        });
      }
      return realFetch(input, init);
    });

    // Ambiguous wording ("look at") routes to Bob's manager locally; the
    // LLM knows better and re-routes to Carol.
    const created = await json(app, `/v1/orgs/${orgId}/instructions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ text: "someone should look at the empty screen thing" }),
    });
    expect(created.status).toBe(201);
    const fastRecipient = created.body.card.recipientUserId as string;
    expect(fastRecipient).not.toBe(byName.Carol);

    await app.queue.drain();
    expect(llmCalls).toBe(1);

    const events = await json(app, `/v1/orgs/${orgId}/events?sinceSeq=0`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const update = events.body.events.find(
      (e: { type: string }) => e.type === "card_updated"
    );
    expect(update.payload.card.recipientUserId).toBe(byName.Carol);
    expect(update.payload.previousRecipientUserId).toBe(fastRecipient);
    expect(update.payload.card.title).toBe("Redesign empty state");
  });

  it("refinement never overwrites a card the recipient already acted on", async () => {
    const app = createApp(
      testConfig({
        openRouter: {
          apiKey: "test",
          model: "test-model",
          appName: "t",
          appUrl: "t",
        },
      })
    );
    const { aliceToken, bobToken, orgId, byName } = await setupOrg(app);

    const realFetch = globalThis.fetch;
    let releaseLlm: () => void = () => {};
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("openrouter.ai")) {
        await llmGate; // hold the refinement until the human has acted
        return openRouterResponse({
          recipientUserId: byName.Carol,
          cardType: "task",
          title: "Should not appear",
          summary: "Should not appear.",
          context: "x: y",
          priority: "low",
          routingReason: "too late",
        });
      }
      return realFetch(input, init);
    });

    const created = await json(app, `/v1/orgs/${orgId}/instructions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ text: "tell Bob to fix the login bug" }),
    });
    const cardId = created.body.card.id as string;

    // Bob approves before the (slow) model returns.
    const approve = await json(app, `/v1/cards/${cardId}/actions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(approve.status).toBe(200);
    releaseLlm();
    await app.queue.drain();

    const events = await json(app, `/v1/orgs/${orgId}/events?sinceSeq=0`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const titles = events.body.events
      .filter((e: { type: string }) => e.type === "card_updated")
      .map((e: { payload: { card: { title: string } } }) => e.payload.card.title);
    expect(titles).not.toContain("Should not appear");
    const cards = await json(app, `/v1/orgs/${orgId}/cards`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    expect(cards.body.cards[0].status).toBe("approved");
  });

  it("skips the refinement job entirely when no LLM is configured", async () => {
    const app = createApp(testConfig());
    const { aliceToken, orgId } = await setupOrg(app);
    await json(app, `/v1/orgs/${orgId}/instructions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ text: "tell Bob to fix the login bug" }),
    });
    expect(app.queue.pending).toBe(0);
  });
});
