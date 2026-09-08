import {
  joinEvents, upsertEvents, removeEvents,
  presenceEvents, contextEvents, applyDecision, applyRollback,
} from "./agui/adapter.js";
import { toolCallResult, runError } from "./agui/events.js";
import {
  loadStore, saveCard, replaceCard, mergeCardEnrichment, removeCard, loadContexts, saveContext,
  getSession, getCard, getUserByLogin, upsertBusiness, businessSlug, getMemberProfile, isLoginMember,
} from "./db.js";
import { appendCardEvent } from "./events.js";
import { writeDecisionToNotion } from "./notionWriter.js";
import { authorizeOrgAccess } from "./membership.js";
import { notifyCard, anyChannelConfigured } from "./notify.js";
import { localizeCard } from "./localize.js";
import { fileCardUnderBusiness } from "./classify.js";
import { providerConfig } from "./provider.js";
import { checkAIAllowance } from "./gate.js";
import { ANNOUNCE_PATH } from "./announce.js";
import { validateIncomingCard, MAX_CONTEXT_BYTES } from "./agui/validate.js";

// One socket's allowance. Well above anything the app does — it sends a message
// per decision, not per frame — and far below what a loop can produce.
const MESSAGE_BUDGET = 120;
const MESSAGE_WINDOW_MS = 10_000;
// No message this product sends is near this; a JSON.parse of something much
// larger is a cost paid before anything has been checked.
const MAX_MESSAGE_BYTES = 256 * 1024;

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
        for (const ev of forEveryone) await this.broadcast(orgId, ev);
        for (const ev of forRecipient) await this.sendTo(orgId, card.recipientUserID, ev);
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

  async broadcast(orgId, obj, exclude) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && ws !== exclude && await this.socketIsAuthorized(ws, att)) {
        try { ws.send(text); } catch { /* One closed socket must not interrupt delivery to others. */ }
      }
    }
  }

  async sendTo(orgId, userId, obj) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && att?.userId === userId && await this.socketIsAuthorized(ws, att)) {
        try { ws.send(text); } catch { /* Continue delivering to the recipient's other devices. */ }
      }
    }
  }

  // A socket outlives its login request. Every read and write must still have
  // a live session and membership; deleting a session, deleting an account, or
  // revoking membership cannot leave a connected device with permanent access.
  async socketIsAuthorized(ws, att = ws.deserializeAttachment() || {}) {
    if (!att.authed) return false;
    // Hibernating sockets created by an older release have no session token
    // in their attachment. Reconnect them so the existing client can join
    // again, rather than treating a deployment as an invalid login.
    if (!att.sessionToken) {
      try { ws.close(1012, "Service updated. Please reconnect."); } catch {}
      return false;
    }
    let active = null;
    if (att.sessionToken && att.githubId && att.userId) {
      try {
        active = await this.db.prepare(
          `SELECT 1 FROM sessions s
           JOIN users u ON u.github_id = s.github_id
           JOIN memberships m ON m.user_github_id = s.github_id
           WHERE s.token = ?1 AND s.github_id = ?2 AND u.login = ?3 AND m.org_id = ?4
             AND (s.expires_at IS NULL OR s.expires_at > ?5)`
        ).bind(att.sessionToken, att.githubId, att.userId, att.orgId, new Date().toISOString()).first();
      } catch {
        // An authorization outage cannot become permission to read private
        // data. 1011 lets clients retry once the service recovers.
        try { ws.close(1011, "Cannot verify access. Please reconnect."); } catch {}
        return false;
      }
    }
    if (!active) this.refuse(ws, att.agui, "Your session or organization access has changed. Please sign in again.");
    return Boolean(active);
  }

  /// Refuse a socket, in whichever dialect it was speaking.
  ///
  /// The close code is 1008 (policy violation) rather than a silent drop so the
  /// client can tell "you are not allowed in" apart from "the network died" and
  /// stop retrying a connection that will never be accepted.
  refuse(ws, agui, message) {
    try { ws.serializeAttachment({ ...ws.deserializeAttachment(), authed: false }); } catch {}
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
    if (type !== "join" && !(await this.socketIsAuthorized(ws, att))) return;
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
      ws.serializeAttachment({ orgId, userId, githubId: String(session.github_id), sessionToken: payload.sessionToken, agui, authed: true });
      const store = await loadStore(this.db, orgId);
      const contexts = await loadContexts(this.db, orgId);
      for (const ev of joinEvents(userId, store, contexts)) ws.send(JSON.stringify(ev));
      // Once, not twice. Presence went out in both dialects to every socket
      // regardless of which one it spoke, so every client received it as a
      // CUSTOM event and again as a legacy message.
      for (const ev of presenceEvents(userId, "online")) await this.broadcast(orgId, ev, ws);
      return;
    }

    if (type === "tool_result") {
      const content = typeof payload.content === "string" ? JSON.parse(payload.content) : payload.content;
      await this.applyAndPublish(orgId, { ...content, actorUserID: att.userId }, payload.toolCallId, att.userId);
      return;
    }

    if (type === "nudge") {
      // A nudge re-raises a decision the recipient has not answered. Only the
      // sender may nudge, and it changes no decision state — it re-sends the
      // card so it resurfaces. upsertEvents returns { forEveryone, forRecipient };
      // forRecipient is the part that re-raises the prompt and is only
      // populated when isNew.
      const card = await getCard(this.db, orgId, payload.cardId);
      if (!card) return;
      if (card.senderUserID !== att.userId) return;
      if (card.decision?.action) return;
      const { forEveryone, forRecipient } = upsertEvents(card, { isNew: true });
      for (const ev of forEveryone) await this.sendTo(orgId, card.recipientUserID, ev);
      for (const ev of forRecipient) await this.sendTo(orgId, card.recipientUserID, ev);
      // The socket only reaches someone with the app open — and a nudge is for
      // the person who has not opened it. This is what makes it reach them.
      if (anyChannelConfigured(this.env)) {
        this.state.waitUntil(
          notifyCard(this.env, {
            card, kind: "nudged", excludeLogin: att.userId,
            badge: await this.pendingCountFor(orgId, card.recipientUserID),
          })
        );
      }
      return;
    }

    if (type === "card_created" || type === "card_updated") {
      if (!payload.card?.id) return;
      const card = payload.card;
      // The schema was served and never enforced, so this took whatever JSON
      // arrived. Every member gets every card in their join snapshot, which is
      // what makes an unbounded field everyone's problem rather than one
      // client's.
      const invalid = validateIncomingCard(card);
      if (invalid) {
        ws.send(JSON.stringify(runError(invalid)));
        return;
      }
      const existing = await getCard(this.db, orgId, card.id);
      if (type === "card_created" && existing) {
        ws.send(JSON.stringify(runError("This decision already exists. Refresh before changing it.")));
        return;
      }
      if (type === "card_updated" && !existing) {
        ws.send(JSON.stringify(runError("This decision no longer exists. Refresh your feed.")));
        return;
      }
      // A business is a slug on the card and a row in the table. A name nobody
      // has typed before becomes a business here — the taxonomy is built by
      // using it, not designed up front.
      if (type === "card_created") {
        // A cached directory or a hand-written socket frame is not proof that
        // the chosen person still belongs here. Check before any filing work;
        // the INSERT repeats this condition atomically after awaited work.
        if (!(await isLoginMember(this.db, orgId, card.recipientUserID))) {
          ws.send(JSON.stringify(runError("That recipient is not a current member of this workspace.")));
          return;
        }
        // You may route a decision to anyone in the org, but only ever as
        // yourself. This is the line that makes a forged sender impossible
        // rather than merely impolite.
        card.senderUserID = att.userId;
        // Who asked, as the card's own record of it. Stamped here from the
        // membership table for the same reason the sender is: a client may
        // not name someone else, and every client can then render the
        // requester without loading the org graph to resolve a login.
        try {
          const profile = await getMemberProfile(this.db, orgId, att.userId);
          if (profile) card.requestedBy = { ...(card.requestedBy || {}), ...profile };
        } catch (err) {
          // A card that does not say who asked is still a card.
          console.error("requester lookup failed", err?.message || err);
        }
      } else {
        // A card belongs to whoever has to decide it. Only they may change it,
        // and rewriting the field must not be a way to hand it off — delegation
        // is a new card, not a moved one.
        const owner = existing.recipientUserID;
        if (owner !== att.userId) {
          ws.send(JSON.stringify(runError("Only the recipient can update this decision.")));
          return;
        }
        card.recipientUserID = owner;
        card.senderUserID = existing.senderUserID;
        card.createdAt = existing.createdAt;
        if (card.decision?.action) card.decision.actorUserID = att.userId;
        // The iOS client republishes its whole local copy on a decision, and
        // that copy does not carry what the relay added after the card was
        // created — the translation, the business, who asked, what the AI
        // advised. A client that does not know a field must not erase it.
        if (existing) {
          for (const field of ["localized", "business", "requestedBy", "recommendation"]) {
            if (card[field] === undefined && existing[field] !== undefined) card[field] = existing[field];
          }
        }
      }
      if (card.business !== undefined) card.business = await this.fileUnder(orgId, card.business, att.githubId);
      const saved = type === "card_created"
        ? await saveCard(this.db, orgId, card, { createOnly: true, requireRecipientMembership: true })
        : await replaceCard(this.db, orgId, card, existing);
      if (!saved) {
        ws.send(JSON.stringify(runError("This decision changed. Refresh your feed and try again.")));
        return;
      }
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
      const { forEveryone, forRecipient } = upsertEvents(card, { isNew: type === "card_created" });
      for (const ev of forEveryone) await this.broadcast(orgId, ev);
      for (const ev of forRecipient) await this.sendTo(orgId, card.recipientUserID, ev);
      // Whoever now has to act hears about it, wherever they are. Same rule as
      // the Notion write and for the same reason: deferred, never awaited, and
      // never able to break the decision it is reporting. A new card is first
      // put into the recipient's language, so the alert — and the card they
      // open — read as if it had been written for them.
      this.state.waitUntil(
        this.deliver(orgId, card, {
          kind: decision?.action ? "decided" : "created",
          excludeLogin: att.userId,
          translate: type === "card_created",
          senderGithubId: att.githubId,
        })
      );
      return;
    }

    if (type === "set_business") {
      // Filing a card under a business changes nothing about the decision, so
      // either party to it may do it: the sender who knows what it was about,
      // or the recipient who is looking at it.
      const card = await getCard(this.db, orgId, payload.cardId);
      if (!card) return;
      if (card.senderUserID !== att.userId && card.recipientUserID !== att.userId) {
        ws.send(JSON.stringify(runError("Only the sender or the recipient can file this decision.")));
        return;
      }
      const business = await this.fileUnder(orgId, payload.business, att.githubId);
      if (business === undefined) return;
      const updated = { ...card, business: business || undefined };
      if (!business) delete updated.business;
      await saveCard(this.db, orgId, updated);
      await this.log(orgId, {
        cardId: card.id, type: "filed", action: business || null, actorUserId: att.userId, snapshot: updated,
      });
      const { forEveryone } = upsertEvents(updated, { isNew: false });
      for (const ev of forEveryone) await this.broadcast(orgId, ev);
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
      for (const ev of removeEvents(payload.cardId)) await this.broadcast(orgId, ev);
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
      for (const ev of contextEvents(userId, payload.context, { isNew })) await this.broadcast(orgId, ev);
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
      await this.broadcast(orgId, notice);
      const { forEveryone } = upsertEvents(card, { isNew: false });
      for (const ev of forEveryone) await this.broadcast(orgId, ev);
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

  /// The slug a card is filed under, creating the business if the name is
  /// new. `null` and "" mean "no business" and come back as null; anything
  /// that does not make a slug is ignored and comes back as undefined.
  async fileUnder(orgId, value, githubId) {
    if (value === null || value === "") return null;
    if (typeof value !== "string" || !businessSlug(value)) return undefined;
    try {
      const business = await upsertBusiness(this.db, orgId, { name: value, createdBy: githubId });
      return business?.slug || undefined;
    } catch (err) {
      console.error("business upsert failed", err?.message || err);
      return businessSlug(value);
    }
  }

  /// Notify whoever a card is now waiting on, after putting a new card into
  /// their language.
  ///
  /// The translation is one model call, paid from the sender's allowance, and
  /// it is skipped whenever it would change nothing: no provider, a recipient
  /// who reads the language the card is already in, or a card that already
  /// carries a version for them. When it produces something, the card is saved
  /// again and re-broadcast so every open device shows the same words the
  /// notification did.
  async deliver(orgId, card, { kind, excludeLogin, translate, senderGithubId }) {
    const provider = providerConfig(this.env);
    const canNotify = anyChannelConfigured(this.env);
    // Nothing to enrich with and nobody to tell: not a single query. This
    // runs after the broadcast, in waitUntil, and a database round trip
    // nobody needed is one that can outlive the request that started it.
    if (!provider && !canNotify) return;

    let current = card;
    try {
      if (translate && provider) {
        const allowance = senderGithubId
          ? await checkAIAllowance(this.env, { githubId: String(senderGithubId) })
          : undefined;
        let changed = false;
        // Which business this is about, decided here rather than asked.
        if (!current.business) {
          const slug = await fileCardUnderBusiness(this.env, {
            orgId, card: current, provider, allowance, githubId: senderGithubId,
          });
          if (slug) { current = { ...current, business: slug }; changed = true; }
        }
        const recipient = await getUserByLogin(this.db, card.recipientUserID);
        const locale = recipient?.locale || "en";
        const localized = await localizeCard(current, { provider, locale, allowance });
        if (localized) { current = localized; changed = true; }
        if (changed) {
          const merged = await mergeCardEnrichment(this.db, orgId, card, current);
          if (merged) {
            current = merged;
            const { forEveryone } = upsertEvents(current, { isNew: false });
            for (const ev of forEveryone) await this.broadcast(orgId, ev);
          }
        }
      }
    } catch (err) {
      // A translation or a filing that fails is a card read in the sender's
      // language, or one without a business — not a card nobody was told about.
      console.error("deliver enrichment failed", err?.message || err);
    }
    if (!canNotify) return;
    // A delayed "new decision" alert must not describe a deleted or already
    // answered card as still waiting. Read the surviving state for the alert.
    current = await getCard(this.db, orgId, card.id);
    if (!current || (kind === "created" && current.status && current.status !== "pending")) return;
    await notifyCard(this.env, {
      card: current,
      kind,
      excludeLogin,
      badge: await this.pendingCountFor(
        orgId,
        kind === "decided" ? current.senderUserID : current.recipientUserID
      ),
    });
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
      for (const ev of removeEvents(out.card.id)) await this.broadcast(orgId, ev);
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
      if (anyChannelConfigured(this.env)) {
        this.state.waitUntil(
          notifyCard(this.env, {
            card: out.card,
            kind: "decided",
            excludeLogin: actorUserId,
            badge: await this.pendingCountFor(orgId, out.card.senderUserID),
          })
        );
      }
      const { forEveryone } = upsertEvents(out.card, { isNew: false });
      for (const ev of forEveryone) await this.broadcast(orgId, ev);
    }
    if (toolCallId) await this.broadcast(orgId, toolCallResult(toolCallId, out.card));
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.userId) {
      for (const ev of presenceEvents(att.userId, "offline")) await this.broadcast(att.orgId, ev, ws);
    }
  }

  webSocketError(ws, err) {
    console.error("ws error", err);
  }
}
