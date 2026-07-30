import test from "node:test";
import assert from "node:assert/strict";
import {
  createChannelStore,
  parseAgentMention,
  stripMention,
  generateAgentReply,
  classifyInput,
  classifyInputLocally,
} from "../channels.js";

test("store seeds #general on first boot", () => {
  const store = createChannelStore(null);
  const { channels } = store.snapshot();
  const names = Object.values(channels).map((channel) => channel.name);
  assert.ok(names.includes("general"));
});

test("store restores from a serialized snapshot without reseeding", () => {
  const first = createChannelStore(null);
  first.createChannel({ name: "design" });
  const restored = createChannelStore(first.serialize());
  const names = Object.values(restored.snapshot().channels).map((c) => c.name);
  assert.deepEqual(names.sort(), ["design", "general"]);
});

test("channel names are normalized and deduplicated", () => {
  const store = createChannelStore(null);
  const a = store.createChannel({ name: "# Launch Plan!" });
  assert.equal(a.name, "launch-plan");
  const b = store.createChannel({ name: "launch-plan" });
  assert.equal(b.id, a.id);
  assert.equal(store.createChannel({ name: "###" }), null);
});

test("messages append with author metadata and cap", () => {
  const store = createChannelStore(null);
  const message = store.addMessage({
    channelID: "channel-general",
    authorID: "user-alice",
    authorKind: "user",
    text: "shipping the relay today",
  });
  assert.equal(message.authorName, "Alice");
  assert.equal(store.recentMessages("channel-general").length, 1);
  assert.equal(store.addMessage({ channelID: "nope", authorID: "user-alice", text: "x" }), null);
  assert.equal(store.addMessage({ channelID: "channel-general", authorID: "user-alice", text: "  " }), null);
});

test("mention parsing: @ai, @ai-alice, none", () => {
  assert.deepEqual(parseAgentMention("hey @ai what's the status?"), {
    ownerID: null,
    agentName: "Team AI",
  });
  assert.deepEqual(parseAgentMention("@ai-alice can you check?"), {
    ownerID: "user-alice",
    agentName: "Alice's AI",
  });
  assert.deepEqual(parseAgentMention("@ai-nobody hello"), {
    ownerID: null,
    agentName: "Team AI",
  });
  assert.equal(parseAgentMention("no mention here"), null);
  assert.equal(parseAgentMention("email@ai.example.com is not a mention") !== null, true);
});

test("stripMention removes the mention token", () => {
  assert.equal(stripMention("@ai file: fix the login bug"), "file: fix the login bug");
});

test("offline agent files a decision from `file:` syntax", async () => {
  const reply = await generateAgentReply({
    agentName: "Team AI",
    channelName: "general",
    recentMessages: [],
    message: { authorID: "user-alice", authorName: "Alice", text: "@ai file: Bob to fix the login bug by Friday" },
    openRouter: null,
  });
  assert.equal(reply.instruction, "Bob to fix the login bug by Friday");
  assert.ok(reply.text.length > 0);
});

const CHANNEL_INDEX = [
  { id: "channel-general", name: "general", purpose: "", recent: [] },
  { id: "channel-onboarding", name: "onboarding-v2", purpose: "Onboarding revamp", recent: [] },
];

test("classify: an ask is a decision", () => {
  const result = classifyInputLocally({
    text: "Ask Bob to review the relay PR",
    senderID: "user-alice",
    channels: CHANNEL_INDEX,
  });
  assert.equal(result.kind, "decision");
});

test("classify: a status report is an update", () => {
  const result = classifyInputLocally({
    text: "Made progress on the relay migration today",
    senderID: "user-alice",
    channels: CHANNEL_INDEX,
  });
  assert.equal(result.kind, "update");
  assert.equal(result.channel, "general");
});

test("classify: updates land in the matching channel", () => {
  const result = classifyInputLocally({
    text: "Wrapped up the empty states for onboarding v2 this morning",
    senderID: "user-carol",
    channels: CHANNEL_INDEX,
  });
  assert.equal(result.kind, "update");
  assert.equal(result.channel, "onboarding-v2");
});

test("classify without an AI key falls back locally", async () => {
  const result = await classifyInput({
    text: "Please approve the launch plan",
    sender: { id: "user-alice", name: "Alice" },
    channels: CHANNEL_INDEX,
    openRouter: null,
  });
  assert.equal(result.kind, "decision");
});

test("offline agent explains itself for plain questions", async () => {
  const reply = await generateAgentReply({
    agentName: "Team AI",
    channelName: "general",
    recentMessages: [],
    message: { authorID: "user-alice", authorName: "Alice", text: "@ai what's our status?" },
    openRouter: null,
  });
  assert.equal(reply.instruction, null);
  assert.ok(reply.text.includes("offline"));
});
