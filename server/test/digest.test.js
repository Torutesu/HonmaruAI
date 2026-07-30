import test from "node:test";
import assert from "node:assert/strict";
import {
  collectDigestSections,
  fallbackDigest,
  generateDigest,
  buildDigestCard,
} from "../digest.js";
import { createChannelStore } from "../channels.js";

function storeWithMessages() {
  const store = createChannelStore(null);
  store.addMessage({
    channelID: "channel-general",
    authorID: "user-alice",
    authorKind: "user",
    text: "Shipped the relay deploy config",
  });
  store.addMessage({
    channelID: "channel-general",
    authorID: "user-carol",
    authorKind: "user",
    text: "Onboarding empty states are done",
  });
  return store;
}

test("collect: excludes own messages and respects since", () => {
  const store = storeWithMessages();

  const forBob = collectDigestSections({ channelStore: store, userID: "user-bob", since: 0 });
  assert.equal(forBob.length, 1);
  assert.equal(forBob[0].messages.length, 2);

  const forAlice = collectDigestSections({ channelStore: store, userID: "user-alice", since: 0 });
  assert.equal(forAlice[0].messages.length, 1);
  assert.equal(forAlice[0].messages[0].authorID, "user-carol");

  const nothingNew = collectDigestSections({
    channelStore: store,
    userID: "user-bob",
    since: Date.now() + 1000,
  });
  assert.equal(nothingNew.length, 0);
});

test("fallback digest counts channels and previews the last message", () => {
  const store = storeWithMessages();
  const sections = collectDigestSections({ channelStore: store, userID: "user-bob", since: 0 });
  const digest = fallbackDigest(sections);
  assert.ok(digest.summary.includes("2 updates across 1 channel"));
  assert.ok(digest.context.includes("#general: 2 new"));
  assert.ok(digest.context.includes("Carol:"));
});

test("generateDigest without an AI key falls back", async () => {
  const store = storeWithMessages();
  const sections = collectDigestSections({ channelStore: store, userID: "user-bob", since: 0 });
  const digest = await generateDigest({ sections, userName: "Bob", openRouter: null });
  assert.ok(digest.summary.length > 0);
});

test("digest card is a quiet self-notification", () => {
  const card = buildDigestCard({
    user: { id: "user-bob", name: "Bob" },
    digest: { summary: "s", context: "c" },
    sectionCount: 2,
  });
  assert.equal(card.recipientUserID, "user-bob");
  assert.equal(card.type, "notification");
  assert.equal(card.priority, "low");
  assert.equal(card.status, "pending");
  assert.ok(card.routingReason.includes("2 channels"));
});
