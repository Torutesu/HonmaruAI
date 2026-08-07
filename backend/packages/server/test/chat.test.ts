import { beforeEach, describe, expect, it } from "vitest";
import { devLogin } from "../src/auth.js";
import {
  ChatError,
  createChannel,
  createChatMessage,
  ensureDefaultChannel,
  listChannelsForUser,
  listChatMessages,
  openDm,
} from "../src/chat.js";
import { openDb, type Db } from "../src/db.js";
import { deriveNotifications } from "../src/notifications.js";
import { createOrg } from "../src/orgs.js";
import { isEventVisibleTo } from "../src/realtime.js";

describe("classic chat (channels + DMs)", () => {
  let db: Db;
  let alice: string;
  let bob: string;
  let carol: string;
  let orgId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    alice = devLogin(db, "Alice").id;
    bob = devLogin(db, "Bob").id;
    carol = devLogin(db, "Carol").id;
    orgId = createOrg(db, alice, "Acme", "PM").id;
    for (const [userId, title] of [
      [bob, "Engineer"],
      [carol, "Designer"],
    ] as const) {
      db.prepare(
        `INSERT INTO memberships (org_id, user_id, title, is_admin, created_at)
         VALUES (?, ?, ?, 0, ?)`
      ).run(orgId, userId, title, new Date().toISOString());
    }
    ensureDefaultChannel(db, orgId);
  });

  it("provides #general to every member, idempotently", () => {
    ensureDefaultChannel(db, orgId);
    const channels = listChannelsForUser(db, orgId, bob);
    expect(channels.filter((ch) => ch.name === "general")).toHaveLength(1);
  });

  it("normalizes channel names and rejects duplicates", () => {
    const { channel } = createChannel(db, orgId, alice, "# Design Reviews ");
    expect(channel.name).toBe("design-reviews");
    expect(() => createChannel(db, orgId, bob, "design-reviews")).toThrow(ChatError);
  });

  it("DMs are idempotent per pair and hidden from outsiders", () => {
    const first = openDm(db, orgId, alice, bob);
    const second = openDm(db, orgId, bob, alice);
    expect(second.channel.id).toBe(first.channel.id);
    expect(second.events).toHaveLength(0);

    expect(listChannelsForUser(db, orgId, carol).map((ch) => ch.id)).not.toContain(
      first.channel.id
    );
    expect(() =>
      createChatMessage(db, carol, first.channel.id, "let me in")
    ).toThrow(ChatError);

    const dmEvent = first.events[0]!;
    expect(isEventVisibleTo(dmEvent, bob)).toBe(true);
    expect(isEventVisibleTo(dmEvent, carol)).toBe(false);
  });

  it("DM messages notify the other member; channel messages only on mention", () => {
    const dm = openDm(db, orgId, alice, bob).channel;
    const dmMessage = createChatMessage(db, alice, dm.id, "lunch?");
    const dmNotifs = deriveNotifications(dmMessage.events);
    expect(dmNotifs).toHaveLength(1);
    expect(dmNotifs[0]).toMatchObject({ userId: bob, kind: "chat_message" });

    const general = listChannelsForUser(db, orgId, alice).find(
      (ch) => ch.name === "general"
    )!;
    const plain = createChatMessage(db, alice, general.id, "shipping today");
    expect(deriveNotifications(plain.events)).toHaveLength(0);

    const mention = createChatMessage(db, alice, general.id, "@Bob can you deploy?");
    const mentionNotifs = deriveNotifications(mention.events);
    expect(mentionNotifs).toHaveLength(1);
    expect(mentionNotifs[0]).toMatchObject({
      userId: bob,
      kind: "chat_mention",
      channelId: general.id,
    });
    expect(mentionNotifs[0]!.title).toContain("#general");
  });

  it("thread replies: one level deep, participants notified", () => {
    const general = listChannelsForUser(db, orgId, alice).find(
      (ch) => ch.name === "general"
    )!;
    const root = createChatMessage(db, alice, general.id, "ship today?").message;
    const reply = createChatMessage(db, bob, general.id, "yes, after tests", root.id);
    expect(reply.message.parentMessageId).toBe(root.id);

    // Alice (thread participant) is notified of Bob's reply.
    const notifs = deriveNotifications(reply.events);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({ userId: alice, kind: "chat_message" });
    expect(notifs[0]!.title).toContain("#general");

    // Carol replies too: Alice and Bob both notified, once each.
    const third = createChatMessage(db, carol, general.id, "docs updated", root.id);
    const thirdNotifs = deriveNotifications(third.events);
    expect(thirdNotifs.map((n) => n.userId).sort()).toEqual([alice, bob].sort());

    // No nested threads; parent must live in the same channel.
    expect(() =>
      createChatMessage(db, alice, general.id, "nested", reply.message.id)
    ).toThrow(ChatError);
    const dm = openDm(db, orgId, alice, bob).channel;
    expect(() => createChatMessage(db, alice, dm.id, "wrong home", root.id)).toThrow(
      ChatError
    );
  });

  it("channel history is ordered and channel events reach all members", () => {
    const general = listChannelsForUser(db, orgId, alice).find(
      (ch) => ch.name === "general"
    )!;
    createChatMessage(db, alice, general.id, "one");
    const { events } = createChatMessage(db, bob, general.id, "two");
    expect(listChatMessages(db, general.id).map((m) => m.text)).toEqual([
      "one",
      "two",
    ]);
    expect(isEventVisibleTo(events[0]!, carol)).toBe(true);
  });
});
