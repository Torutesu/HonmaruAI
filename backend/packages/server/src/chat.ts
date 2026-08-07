import type { Channel, ChatMessage, OrgEvent } from "@honmaru/protocol";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { newId, now } from "./ids.js";
import { parseMentions } from "./messages.js";
import { listMembers, OrgError } from "./orgs.js";

// ---------------------------------------------------------------------------
// Classic chat layer — the "traditional Slack" mode. Org-wide channels
// plus 1:1 DMs, on the same event log / realtime pipeline as cards, so
// both UI modes stay in sync for free. @mentions work here too.
// ---------------------------------------------------------------------------

export class ChatError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

interface ChannelRow {
  id: string;
  org_id: string;
  kind: "channel" | "dm";
  name: string;
  created_at: string;
}

function toChannel(db: Db, row: ChannelRow): Channel {
  const members =
    row.kind === "dm"
      ? (
          db
            .prepare("SELECT user_id FROM channel_members WHERE channel_id = ?")
            .all(row.id) as { user_id: string }[]
        ).map((member) => member.user_id)
      : [];
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    name: row.name,
    memberUserIds: members,
    createdAt: row.created_at,
  };
}

export function getChannel(db: Db, channelId: string): Channel | null {
  const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as
    | ChannelRow
    | undefined;
  return row ? toChannel(db, row) : null;
}

export function isChannelVisibleTo(channel: Channel, userId: string): boolean {
  return channel.kind === "channel" || channel.memberUserIds.includes(userId);
}

// All org channels plus the user's DMs.
export function listChannelsForUser(
  db: Db,
  orgId: string,
  userId: string
): Channel[] {
  const rows = db
    .prepare("SELECT * FROM channels WHERE org_id = ? ORDER BY created_at ASC")
    .all(orgId) as ChannelRow[];
  return rows
    .map((row) => toChannel(db, row))
    .filter((channel) => isChannelVisibleTo(channel, userId));
}

// Created silently (no event) when the org itself is created — there are
// no listeners yet and joiners get channels in the welcome frame.
export function ensureDefaultChannel(db: Db, orgId: string): Channel {
  const existing = db
    .prepare(
      "SELECT * FROM channels WHERE org_id = ? AND kind = 'channel' AND name = 'general'"
    )
    .get(orgId) as ChannelRow | undefined;
  if (existing) return toChannel(db, existing);
  const channel: Channel = {
    id: newId("ch"),
    orgId,
    kind: "channel",
    name: "general",
    memberUserIds: [],
    createdAt: now(),
  };
  db.prepare(
    "INSERT INTO channels (id, org_id, kind, name, created_at) VALUES (?, ?, 'channel', ?, ?)"
  ).run(channel.id, orgId, channel.name, channel.createdAt);
  return channel;
}

export function createChannel(
  db: Db,
  orgId: string,
  actorUserId: string,
  rawName: string
): { channel: Channel; events: OrgEvent[] } {
  const name = rawName
    .trim()
    .replace(/^#/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  if (!name) throw new ChatError("invalid_channel", "Channel name required.");
  const duplicate = db
    .prepare(
      "SELECT id FROM channels WHERE org_id = ? AND kind = 'channel' AND name = ?"
    )
    .get(orgId, name);
  if (duplicate) throw new ChatError("channel_exists", `#${name} already exists.`);

  const channel: Channel = {
    id: newId("ch"),
    orgId,
    kind: "channel",
    name,
    memberUserIds: [],
    createdAt: now(),
  };
  const events: OrgEvent[] = [];
  db.transaction(() => {
    db.prepare(
      "INSERT INTO channels (id, org_id, kind, name, created_at) VALUES (?, ?, 'channel', ?, ?)"
    ).run(channel.id, orgId, channel.name, channel.createdAt);
    events.push(appendEvent(db, orgId, "channel_created", actorUserId, { channel }));
  })();
  return { channel, events };
}

// Idempotent: one DM per member pair.
export function openDm(
  db: Db,
  orgId: string,
  actorUserId: string,
  otherUserId: string
): { channel: Channel; events: OrgEvent[] } {
  if (actorUserId === otherUserId) {
    throw new ChatError("invalid_dm", "Pick another member to DM.");
  }
  const other = db
    .prepare("SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?")
    .get(orgId, otherUserId);
  if (!other) throw new OrgError("not_a_member", "That user is not in this org.");

  const existing = db
    .prepare(
      `SELECT c.* FROM channels c
       WHERE c.org_id = ? AND c.kind = 'dm'
         AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
         AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)`
    )
    .get(orgId, actorUserId, otherUserId) as ChannelRow | undefined;
  if (existing) return { channel: toChannel(db, existing), events: [] };

  const channel: Channel = {
    id: newId("dm"),
    orgId,
    kind: "dm",
    name: "",
    memberUserIds: [actorUserId, otherUserId],
    createdAt: now(),
  };
  const events: OrgEvent[] = [];
  db.transaction(() => {
    db.prepare(
      "INSERT INTO channels (id, org_id, kind, name, created_at) VALUES (?, ?, 'dm', '', ?)"
    ).run(channel.id, orgId, channel.createdAt);
    const insert = db.prepare(
      "INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)"
    );
    insert.run(channel.id, actorUserId);
    insert.run(channel.id, otherUserId);
    events.push(appendEvent(db, orgId, "channel_created", actorUserId, { channel }));
  })();
  return { channel, events };
}

interface ChatRow {
  id: string;
  org_id: string;
  channel_id: string;
  author_user_id: string;
  text: string;
  created_at: string;
}

function toMessage(row: ChatRow): ChatMessage {
  return {
    id: row.id,
    orgId: row.org_id,
    channelId: row.channel_id,
    authorUserId: row.author_user_id,
    text: row.text,
    createdAt: row.created_at,
  };
}

export function listChatMessages(
  db: Db,
  channelId: string,
  limit = 100
): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT *, rowid AS rid FROM chat_messages WHERE channel_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?
       ) ORDER BY created_at ASC, rid ASC`
    )
    .all(channelId, limit) as ChatRow[];
  return rows.map(toMessage);
}

export function createChatMessage(
  db: Db,
  authorUserId: string,
  channelId: string,
  text: string
): { message: ChatMessage; events: OrgEvent[] } {
  const channel = getChannel(db, channelId);
  if (!channel) throw new ChatError("channel_not_found", "Channel not found.");
  if (!isChannelVisibleTo(channel, authorUserId)) {
    throw new ChatError("not_allowed", "You are not in this conversation.");
  }

  const mentionedUserIds = parseMentions(
    text,
    listMembers(db, channel.orgId),
    authorUserId
  ).filter((userId) => isChannelVisibleTo(channel, userId));

  const message: ChatMessage = {
    id: newId("cm"),
    orgId: channel.orgId,
    channelId,
    authorUserId,
    text,
    createdAt: now(),
  };
  const events: OrgEvent[] = [];
  db.transaction(() => {
    db.prepare(
      `INSERT INTO chat_messages (id, org_id, channel_id, author_user_id, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      message.id,
      message.orgId,
      message.channelId,
      message.authorUserId,
      message.text,
      message.createdAt
    );
    events.push(
      appendEvent(db, channel.orgId, "chat_message_created", authorUserId, {
        message,
        channelKind: channel.kind,
        channelName: channel.name,
        memberUserIds: channel.memberUserIds,
        mentionedUserIds,
      })
    );
  })();
  return { message, events };
}
