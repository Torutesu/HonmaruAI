import {
  joinEvents, upsertEvents, removeEvents,
  presenceEvents, contextEvents, applyDecision, applyRollback,
} from "./agui/adapter.js";
import { toolCallResult, runError } from "./agui/events.js";
import {
  loadStore, saveCard, removeCard, loadContexts, saveContext,
  getSession, getCard,
} from "./db.js";
import { appendCardEvent } from "./events.js";
import { writeDecisionToNotion } from "./notionWriter.js";
import { authorizeOrgAccess } from "./membership.js";
import { notifyCard } from "./push.js";

export class OrgRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.db = env.DB;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const orgId = url.searchParams.get("orgId") || "core-team";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server); // hibernation API
    server.serializeAttachment({ orgId, userId: null, agui: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(orgId, obj, exclude) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && ws !== exclude) ws.send(text);
    }
  }

  sendTo(orgId, userId, obj) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && att?.userId === userId) ws.send(text);
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

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment() || {};
    const orgId = att.orgId || "core-team";
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload = {} } = msg;

    // Everything except `join` requires a socket that has already proved who it
    // is. Checking inside each handler would eventually miss one; checking here
    // means a new message type is authenticated by default.
    if (type !== "join" && !att.authed) {
      return this.refuse(ws, att.agui, "Join with a valid session before sending anything.");
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
      const userId = access.login;
      ws.serializeAttachment({ orgId, userId, githubId: String(session.github_id), agui, authed: true });
      const store = await loadStore(this.db, orgId);
      const contexts = await loadContexts(this.db, orgId);
      if (agui) {
        for (const ev of joinEvents(userId, store, contexts)) ws.send(JSON.stringify(ev));
      } else {
        ws.send(JSON.stringify({ type: "snapshot", payload: { cardsByUser: store } }));
      }
      this.broadcast(orgId, { type: "presence", payload: { userId, status: "online" } }, ws);
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
      const card = payload.card;
      const existing = await getCard(this.db, orgId, card.id);
      if (type === "card_created") {
        // You may route a decision to anyone in the org, but only ever as
        // yourself. This is the line that makes a forged sender impossible
        // rather than merely impolite.
        card.senderUserID = att.userId;
      } else {
        // A card belongs to whoever has to decide it. Only they may change it,
        // and rewriting the field must not be a way to hand it off — delegation
        // is a new card, not a moved one.
        const owner = existing?.recipientUserID ?? card.recipientUserID;
        if (owner !== att.userId) {
          ws.send(JSON.stringify(runError("Only the recipient can update this decision.")));
          return;
        }
        card.recipientUserID = owner;
        if (card.decision?.action) card.decision.actorUserID = att.userId;
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
      for (const ev of forEveryone) this.broadcast(orgId, ev);
      for (const ev of forRecipient) this.sendTo(orgId, card.recipientUserID, ev);
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
      for (const ev of removeEvents(payload.cardId)) this.broadcast(orgId, ev);
      return;
    }

    if (type === "context_updated") {
      // Your context, never someone else's — a claimed userId is ignored.
      const userId = att.userId;
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
      const store = await loadStore(this.db, orgId);
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
      this.broadcast(orgId, notice);
      const { forEveryone } = upsertEvents(card, { isNew: false });
      for (const ev of forEveryone) this.broadcast(orgId, ev);
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
    const store = await loadStore(this.db, orgId);
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
      for (const ev of removeEvents(out.card.id)) this.broadcast(orgId, ev);
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
      for (const ev of forEveryone) this.broadcast(orgId, ev);
    }
    if (toolCallId) this.broadcast(orgId, toolCallResult(toolCallId, out.card));
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
