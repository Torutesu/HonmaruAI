import {
  joinEvents, upsertEvents, removeEvents,
  presenceEvents, contextEvents, applyDecision, applyRollback,
} from "./agui/adapter.js";
import { toolCallResult, runError } from "./agui/events.js";
import {
  loadStore, saveCard, removeCard, loadContexts, saveContext,
  getSession, getCard, isMemberLogin,
} from "./db.js";
import { appendCardEvent } from "./events.js";
import { writeDecisionToNotion } from "./notionWriter.js";
import { authorizeOrgAccess } from "./membership.js";
import { notifyCard } from "./push.js";
import { ANNOUNCE_PATH } from "./announce.js";
import { validateIncomingCard, CARD_STATUSES, MAX_CONTEXT_BYTES } from "./agui/validate.js";

// One socket's allowance. Well above anything the app does — it sends a message
// per decision, not per frame — and far below what a loop can produce.
const MESSAGE_BUDGET = 120;
const MESSAGE_WINDOW_MS = 10_000;
// No message this product sends is near this; a JSON.parse of something much
// larger is a cost paid before anything has been checked.
const MAX_MESSAGE_BYTES = 256 * 1024;

/// What the recipient of a card is allowed to change about it.
///
/// Everything else is the sender's account of what they asked for — the title,
/// the summary, who asked, when, and where it came from. Until this list
/// existed, `card_updated` stored whatever JSON arrived as long as the sender
/// was the recipient, so the person deciding could re-attribute the request to
/// a colleague who never made it, backdate it, or change the source it claims
/// to have come from. The audit log then recorded the forged version as fact,
/// because it snapshots the card it was handed.
const RECIPIENT_MUTABLE = [
  "status",
  "decision",
  "revisionNote",
  "context",
  "priority",
  "githubIssueNumber",
  "githubIssueURL",
  "githubRepository",
];

function mergeRecipientEdit(existing, incoming) {
  const merged = { ...existing };
  for (const field of RECIPIENT_MUTABLE) {
    if (incoming[field] !== undefined) merged[field] = incoming[field];
  }
  return merged;
}

export class OrgRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.db = env.DB;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const orgId = url.searchParams.get("orgId") || "core-team";

    // Cards written outside this object — a connector sync, which runs in the
    // Worker and writes straight to D1 — are announced through here so they
    // reach open sockets now rather than on the next reconnect.
    //
    // Only the binding can reach this: the public handler forwards to the stub
    // only for `Upgrade: websocket`. The check is repeated rather than assumed,
    // because that is one edit away from not being true.
    if (url.pathname === ANNOUNCE_PATH && request.headers.get("Upgrade") !== "websocket") {
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      let cards = [];
      try { ({ cards = [] } = await request.json()); } catch { return new Response("bad request", { status: 400 }); }
      for (const card of cards) {
        if (!card?.id) continue;
        const { forEveryone, forRecipient } = upsertEvents(card, { isNew: true });
        for (const ev of forEveryone) this.sendToParties(orgId, card, ev);
        for (const ev of forRecipient) this.sendTo(orgId, card.recipientUserID, ev);
      }
      return new Response(JSON.stringify({ announced: cards.length }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server); // hibernation API
    server.serializeAttachment({ orgId, userId: null, agui: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  /// Send to one socket, and let a dead one stay dead.
  ///
  /// A socket that has closed but not yet been reaped throws from `send`. The
  /// loops below used to let that escape: the iteration stopped at the corpse,
  /// every socket after it in the list heard nothing, and the throw surfaced to
  /// the *sender* as a RUN_ERROR — telling them their decision had failed after
  /// it was already written to D1.
  static deliver(ws, text) {
    try {
      ws.send(text);
    } catch {
      // Nothing to do and nothing to say: the close handler will remove it.
    }
  }

  broadcast(orgId, obj, exclude) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && ws !== exclude) OrgRelay.deliver(ws, text);
    }
  }

  /// Deliver a card event to the people it concerns.
  ///
  /// A decision names two people: whoever asked and whoever has to answer.
  /// Everything about a card used to go to every socket in the organization,
  /// with the app filtering by recipient on the way in — so a card that named a
  /// salary, a contract or a client sat in the cache of every phone on the
  /// team, and any of them could read it straight out of the join snapshot.
  ///
  /// Presence and shared context still go to everyone: they are about the room,
  /// not about a decision.
  sendToParties(orgId, card, obj) {
    const parties = new Set(
      [card?.recipientUserID, card?.senderUserID, card?.originSenderUserID].filter(Boolean)
    );
    if (!parties.size) return this.broadcast(orgId, obj);
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && parties.has(att.userId)) OrgRelay.deliver(ws, text);
    }
  }

  sendTo(orgId, userId, obj) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && att?.userId === userId) OrgRelay.deliver(ws, text);
    }
  }

  /// Refuse a socket, in whichever dialect it was speaking.
  ///
  /// The close code is 1008 (policy violation) rather than a silent drop so the
  /// client can tell "you are not allowed in" apart from "the network died" and
  /// stop retrying a connection that will never be accepted.
  refuse(ws, agui, message) {
    try {
      ws.send(JSON.stringify(agui ? runError(message) : { type: "error", payload: { message } }));
    } catch {}
    try {
      ws.close(1008, message);
    } catch {}
  }

  /// How many decisions are waiting on someone — the number that belongs on
  /// their app icon. Counted in SQL rather than by loading the org's cards,
  /// because this runs on the path of every card.
  async pendingCountFor(orgId, login) {
    if (!login) return undefined;
    try {
      const row = await this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1 AND recipient_user_id = ?2 AND status = 'pending'"
        )
        .bind(orgId, login)
        .first();
      return Number(row?.n ?? 0);
    } catch {
      // A badge we cannot count is a badge we do not set. Leaving the icon as
      // it was beats putting a wrong number on it.
      return undefined;
    }
  }

  /// Recording history must never break the mutation it records.
  async log(orgId, event) {
    try {
      await appendCardEvent(this.db, orgId, event);
    } catch (err) {
      console.error("card event log failed", err);
    }
  }

  /// A budget for one socket's traffic.
  ///
  /// Everything below this line is authenticated, which was doing all the work:
  /// a member could hold a socket open and write as fast as it could send, and
  /// `context_updated` puts whatever it is given into D1. Being allowed in is
  /// not the same as being allowed to do it a thousand times a second.
  ///
  /// In memory, so it is lost when the object hibernates. That fails toward
  /// letting someone through after an idle gap, which is the right way for a
  /// limiter to be wrong.
  overBudget(userId) {
    const now = Date.now();
    const window = this.messageWindow ||= new Map();
    const seen = window.get(userId);
    if (!seen || now - seen.since > MESSAGE_WINDOW_MS) {
      window.set(userId, { since: now, count: 1 });
      return false;
    }
    seen.count += 1;
    return seen.count > MESSAGE_BUDGET;
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment() || {};
    const orgId = att.orgId || "core-team";

    // Checked on the raw frame, before parsing: a 5 MB string is expensive to
    // JSON.parse and there is no message this product sends that is anywhere
    // near it.
    if (typeof raw === "string" && raw.length > MAX_MESSAGE_BYTES) {
      return this.refuse(ws, att.agui, "That message is too large.");
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload = {} } = msg;

    // Everything except `join` requires a socket that has already proved who it
    // is. Checking inside each handler would eventually miss one; checking here
    // means a new message type is authenticated by default.
    if (type !== "join" && !att.authed) {
      return this.refuse(ws, att.agui, "Join with a valid session before sending anything.");
    }
    if (type !== "join" && this.overBudget(att.userId)) {
      // Told, not closed: a burst is far more often a client bug than an
      // attack, and dropping the socket turns a recoverable moment into a
      // reconnect loop.
      try { ws.send(JSON.stringify(runError("Too many messages. Slow down."))); } catch {}
      return;
    }

    try {
    if (type === "join") {
      const agui = payload.protocol === "agui/1";
      // Identity is never taken from the client. `payload.userId` is read only
      // to be discarded: whoever you say you are, you act as the login on your
      // session, in the org that session can prove it belongs to.
      const session = payload.sessionToken ? await getSession(this.db, payload.sessionToken) : null;
      if (!session) {
        return this.refuse(ws, agui, "Sign in to join this organization.");
      }
      const access = await authorizeOrgAccess(this.env, session, orgId);
      if (!access.ok) {
        return this.refuse(ws, agui, "You are not a member of this organization.");
      }
      // The legacy dialect is refused rather than half-served. A client that
      // joined without `agui/1` used to get a snapshot and then silence: every
      // broadcast below this line is an AG-UI event, so its feed froze at the
      // moment it connected and looked, from the inside, exactly like a quiet
      // team. Saying "update the app" is the honest version of that.
      if (!agui) {
        return this.refuse(ws, false, "This version is too old to connect. Please update the app.");
      }

      const userId = access.login;
      ws.serializeAttachment({ orgId, userId, githubId: String(session.github_id), agui, authed: true });
      const store = await loadStore(this.db, orgId, userId);
      const contexts = await loadContexts(this.db, orgId);
      for (const ev of joinEvents(userId, store, contexts)) ws.send(JSON.stringify(ev));
      // Once, not twice. Presence went out in both dialects to every socket
      // regardless of which one it spoke, so every client received it as a
      // CUSTOM event and again as a legacy message.
      for (const ev of presenceEvents(userId, "online")) this.broadcast(orgId, ev, ws);
      return;
    }

    if (type === "tool_result") {
      const content = typeof payload.content === "string" ? JSON.parse(payload.content) : payload.content;
      await this.applyAndPublish(orgId, { ...content, actorUserID: att.userId }, payload.toolCallId, att.userId);
      return;
    }

    if (type === "card_created" || type === "card_updated") {
      if (!payload.card?.id) return;
      const incoming = payload.card;
      // The schema was served and never enforced, so this took whatever JSON
      // arrived. Every member gets every card in their join snapshot, which is
      // what makes an unbounded field everyone's problem rather than one
      // client's.
      const invalid = validateIncomingCard(incoming);
      if (invalid) {
        ws.send(JSON.stringify(runError(invalid)));
        return;
      }
      const existing = await getCard(this.db, orgId, incoming.id);
      let card;
      if (type === "card_created") {
        if (existing) {
          // An id that is already taken is not a new card. `saveCard` upserts,
          // so without this any member could name an existing id and replace
          // someone else's decision wholesale — recipient, status, decision and
          // all. Every member knows every id, because the join snapshot hands
          // them out.
          //
          // Your own card coming round again is a different thing: the outbox
          // replays on reconnect, and that has to stay idempotent. It is
          // answered with the stored card rather than a write.
          if (existing.senderUserID !== att.userId) {
            ws.send(JSON.stringify(runError("A decision with that id already exists.")));
            return;
          }
          const { forEveryone } = upsertEvents(existing, { isNew: false });
          for (const ev of forEveryone) this.sendToParties(orgId, existing, ev);
          return;
        }
        // You may route a decision to anyone in the org, but only ever as
        // yourself. This is the line that makes a forged sender impossible
        // rather than merely impolite.
        card = { ...incoming, senderUserID: att.userId };
        // And only to someone who is actually in the org. A card addressed to a
        // login that cannot join is a decision nobody will ever make, kept
        // forever in everyone's snapshot; addressed to a login in a *different*
        // org it is a push notification, with an attacker's title, on a
        // stranger's phone — `device_tokens` is keyed by login alone.
        // Both ends of the chain, for the same reason: a party to a card
        // receives everything about it, so naming a stranger here would hand
        // them a card and a notification.
        for (const login of [card.recipientUserID, card.originSenderUserID].filter(Boolean)) {
          if (!(await isMemberLogin(this.db, orgId, login))) {
            ws.send(JSON.stringify(runError("That person is not in this organization.")));
            return;
          }
        }
      } else {
        // A card belongs to whoever has to decide it. Only they may change it,
        // and rewriting the field must not be a way to hand it off — delegation
        // is a new card, not a moved one.
        if (!existing) {
          // An update to a card that is not here cannot be authorized against
          // anything, and taking it would let `card_updated` create a card with
          // a sender of the client's choosing — the hole `card_created` closes
          // above, reopened through the other door.
          ws.send(JSON.stringify(runError("That decision no longer exists.")));
          return;
        }
        if (existing.recipientUserID !== att.userId) {
          ws.send(JSON.stringify(runError("Only the recipient can update this decision.")));
          return;
        }
        card = mergeRecipientEdit(existing, incoming);
        if (card.decision?.action) card.decision = { ...card.decision, actorUserID: att.userId };
      }
      await saveCard(this.db, orgId, card);
      // The iOS client decides locally and republishes the whole card, so a
      // card_updated that carries a decision IS a decision — recording it as a
      // bland "updated" would make the history useless.
      const decision = type === "card_updated" ? card.decision : undefined;
      await this.log(orgId, {
        cardId: card.id,
        type: decision?.action ? "decided" : (type === "card_created" ? "created" : "updated"),
        action: decision?.action,
        actorUserId: decision?.action
          ? (decision.actorUserID || att.userId)
          : (type === "card_created" ? (card.senderUserID || att.userId) : att.userId),
        note: decision?.note || decision?.replyText,
        snapshot: card,
      });
      // A decision also lands as a row in the decider's Notion database, if they
      // connected one. waitUntil, not await: the design's rule is that a Notion
      // failure — or a slow Notion — must never break or stall the decision, so
      // the broadcast below goes out immediately and the write settles after.
      // writeDecisionToNotion never throws, so an unhandled rejection cannot
      // escape here either.
      if (decision?.action) {
        this.state.waitUntil(
          writeDecisionToNotion({
            env: this.env,
            orgId,
            login: decision.actorUserID || att.userId,
            card,
          })
        );
      }
      // Whoever now has to act hears about it on their phone. Same rule as the
      // Notion write and for the same reason: deferred, never awaited, and
      // never able to break the decision it is reporting.
      this.state.waitUntil(
        notifyCard(this.env, {
          card,
          kind: decision?.action ? "decided" : "created",
          excludeLogin: att.userId,
          badge: await this.pendingCountFor(
            orgId,
            decision?.action ? card.senderUserID : card.recipientUserID
          ),
        })
      );
      const { forEveryone, forRecipient } = upsertEvents(card, { isNew: type === "card_created" });
      for (const ev of forEveryone) this.sendToParties(orgId, card, ev);
      for (const ev of forRecipient) this.sendTo(orgId, card.recipientUserID, ev);
      return;
    }

    // What happened to a decision *after* it was made: the GitHub issue it
    // produced, or that issue being opened or closed again.
    //
    // The app watches its own issues and reports what it sees. That used to
    // arrive as `card_updated` carrying the whole card, decision included — so
    // the relay read every report as a fresh decision and, each time, wrote
    // another row into the decider's Notion database, sent another push to the
    // person who asked, and left another "decided" line in the history. Closing
    // an issue on GitHub was enough to do it.
    //
    // This message says only what changed, and the decision is not part of it.
    if (type === "card_synced") {
      const { cardId, status, githubIssueNumber, githubIssueURL, githubRepository } = payload;
      if (!cardId) return;
      const target = await getCard(this.db, orgId, cardId);
      if (!target) return;
      if (target.recipientUserID !== att.userId) {
        ws.send(JSON.stringify(runError("Only the recipient can update this decision.")));
        return;
      }

      const card = { ...target };
      if (status !== undefined) {
        if (!CARD_STATUSES.has(status)) {
          ws.send(JSON.stringify(runError(`Unknown status: ${status}`)));
          return;
        }
        card.status = status;
      }
      if (githubIssueNumber !== undefined) card.githubIssueNumber = githubIssueNumber;
      if (githubIssueURL !== undefined) card.githubIssueURL = githubIssueURL;
      if (githubRepository !== undefined) card.githubRepository = githubRepository;
      if (JSON.stringify(card) === JSON.stringify(target)) return;

      await saveCard(this.db, orgId, card);
      // Recorded as what it is. The history distinguishes "hubot decided this"
      // from "the issue behind it closed", which is the difference between a
      // person acting and a system catching up.
      await this.log(orgId, {
        cardId, type: "synced", actorUserId: att.userId, snapshot: card,
      });
      const { forEveryone } = upsertEvents(card, { isNew: false });
      for (const ev of forEveryone) this.sendToParties(orgId, card, ev);
      return;
    }

    if (type === "card_deleted") {
      if (!payload.cardId) return;
      const doomed = await getCard(this.db, orgId, payload.cardId);
      if (doomed && doomed.recipientUserID !== att.userId) {
        ws.send(JSON.stringify(runError("Only the recipient can delete this decision.")));
        return;
      }
      await removeCard(this.db, orgId, payload.cardId);
      if (doomed) {
        await this.log(orgId, {
          cardId: doomed.id, type: "deleted", actorUserId: att.userId, snapshot: doomed,
        });
      }
      // A removal carries an id and nothing else, so it is safe to tell the
      // room when we no longer know whose card it was.
      for (const ev of removeEvents(payload.cardId)) this.sendToParties(orgId, doomed, ev);
      return;
    }

    if (type === "context_updated") {
      // Your context, never someone else's — a claimed userId is ignored.
      const userId = att.userId;
      if (typeof payload.context !== "object" || payload.context === null) {
        ws.send(JSON.stringify(runError("A context object is required.")));
        return;
      }
      if (JSON.stringify(payload.context).length > MAX_CONTEXT_BYTES) {
        ws.send(JSON.stringify(runError("That context is too large.")));
        return;
      }
      const existing = await loadContexts(this.db, orgId);
      const isNew = !(userId in existing);
      await saveContext(this.db, orgId, userId, payload.context);
      for (const ev of contextEvents(userId, payload.context, { isNew })) this.broadcast(orgId, ev);
      return;
    }

    if (type === "rollback") {
      const target = await getCard(this.db, orgId, payload.cardId);
      if (target && target.recipientUserID !== att.userId) {
        ws.send(JSON.stringify(runError("Only the recipient can undo this decision.")));
        return;
      }
      const store = await loadStore(this.db, orgId, att.userId);
      const before = JSON.parse(JSON.stringify(
        Object.values(store).flat().find((item) => item.id === payload.cardId) || null
      ));
      const { card, notice } = applyRollback(store, payload.cardId, att.userId);
      await saveCard(this.db, orgId, card);
      await this.log(orgId, {
        cardId: card.id,
        type: "rolled_back",
        action: before?.decision?.action,
        actorUserId: att.userId,
        snapshot: before || card,
      });
      this.sendToParties(orgId, card, notice);
      const { forEveryone } = upsertEvents(card, { isNew: false });
      for (const ev of forEveryone) this.sendToParties(orgId, card, ev);
      return;
    }

    // `clear_store` used to run DELETE FROM cards for the whole org, and the app
    // sent it on every sign-out — one person leaving erased every pending
    // decision the team had. Deleting the message type outright would crash the
    // TestFlight builds that still send it, so it stays and does nothing.
    // Clearing local state is a client concern and always was.
    if (type === "clear_store") {
      return;
    }
    } catch (err) {
      try { ws.send(JSON.stringify(runError(err.message))); } catch {}
    }
  }

  async applyAndPublish(orgId, content, toolCallId, actorUserId) {
    const store = await loadStore(this.db, orgId, actorUserId);
    if (actorUserId && content?.cardId) {
      const target = await getCard(this.db, orgId, content.cardId);
      if (target && target.recipientUserID !== actorUserId) {
        throw new Error("Only the recipient can decide this card.");
      }
    }
    const out = applyDecision(store, content);
    if (out.removed) {
      await removeCard(this.db, orgId, out.card.id);
      await this.log(orgId, {
        cardId: out.card.id, type: "deleted", action: content.action,
        actorUserId: content.actorUserID, note: content.note, snapshot: out.card,
      });
      for (const ev of removeEvents(out.card.id)) this.sendToParties(orgId, out.card, ev);
    } else if (!out.unchanged) {
      await saveCard(this.db, orgId, out.card);
      await this.log(orgId, {
        cardId: out.card.id, type: "decided", action: content.action,
        actorUserId: content.actorUserID, note: content.note || content.replyText,
        snapshot: out.card,
      });
      // A decision is a decision whichever message carried it. These two used
      // to hang off `card_updated` only, because that was the one way the app
      // announced a decision; now that it answers the `request_decision` tool
      // call instead, they have to happen here too or connecting a Notion
      // database — and being told your decision landed — would quietly stop
      // working. Same rule as over there: deferred, never awaited, and never
      // able to break the decision it is reporting.
      this.state.waitUntil(
        writeDecisionToNotion({
          env: this.env,
          orgId,
          login: out.card.decision?.actorUserID || actorUserId,
          card: out.card,
        })
      );
      this.state.waitUntil(
        notifyCard(this.env, {
          card: out.card,
          kind: "decided",
          excludeLogin: actorUserId,
          badge: await this.pendingCountFor(orgId, out.card.senderUserID),
        })
      );
      const { forEveryone } = upsertEvents(out.card, { isNew: false });
      for (const ev of forEveryone) this.sendToParties(orgId, out.card, ev);
    }
    if (toolCallId) this.sendToParties(orgId, out.card, toolCallResult(toolCallId, out.card));
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.userId) {
      for (const ev of presenceEvents(att.userId, "offline")) this.broadcast(att.orgId, ev, ws);
    }
  }

  webSocketError(ws, err) {
    console.error("ws error", err);
  }
}
