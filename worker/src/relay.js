import { noteActivity } from "./pushes.js";
import { settleUsage } from "./ledger.js";
import {
  joinEvents, upsertEvents, removeEvents,
  presenceEvents, contextEvents, applyDecision, applyRollback,
} from "./agui/adapter.js";
import { toolCallResult, runError } from "./agui/events.js";
import {
  loadStore, saveCard, removeCard, loadContexts, saveContext,
  getSession, getCard, getUserByLogin, upsertBusiness, businessSlug, getMemberProfile,
  isOrgMemberLogin,
} from "./db.js";
import { appendCardEvent } from "./events.js";
import { writeDecisionToNotion } from "./notionWriter.js";
import { authorizeOrgAccess } from "./membership.js";
import { notifyCard, anyChannelConfigured } from "./notify.js";
import { localizeCard } from "./localize.js";
import { fileCardUnderBusiness } from "./classify.js";
import { providerFor } from "./orgAI.js";
import { syncCardToGitHub, getWorkspaceGitHub } from "./githubWorkspace.js";
import { allowanceFor } from "./gate.js";
import { ANNOUNCE_PATH, EVICT_PATH, EVENTS_PATH } from "./announce.js";
import { emitCard } from "./webhooks.js";
import { validateIncomingCard, MAX_CONTEXT_BYTES } from "./agui/validate.js";
import { applyAutoRule } from "./autorules.js";
import { redirectIfAway } from "./people.js";
import { listMembers } from "./team.js";
import { isGuest } from "./access.js";
import { learnFromDecision } from "./memory.js";
import { settleProposal } from "./proposals.js";
import { JAM_TYPES, JAM_SIGNAL_BUDGET, handleJamMessage, leaveJam, jamStatesFor } from "./jam.js";

/// Said to a client that tries to put an unposted daily report away.
const DRAFT_MUST_POST = "This daily report is a draft: check it and post it to finish it.";

// One socket's allowance. Well above anything the app does — it sends a message
// per decision, not per frame — and far below what a loop can produce.
const MESSAGE_BUDGET = 120;
const MESSAGE_WINDOW_MS = 10_000;
// No message this product sends is near this; a JSON.parse of something much
// larger is a cost paid before anything has been checked.
const MAX_MESSAGE_BYTES = 256 * 1024;
// `join` runs before `overBudget` can name a user, so it gets its own bound:
// a handful of attempts per socket, each of which costs a session lookup and
// a membership check against D1.
const MAX_JOINS_PER_SOCKET = 5;

export class OrgRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.db = env.DB;
  }

  async fetch(request) {
    const url = new URL(request.url);
    // The public handler already refused a socket without an orgId; the
    // internal paths always carry one. Nothing here belongs to a default room.
    const orgId = url.searchParams.get("orgId");
    if (!orgId) return new Response("orgId is required", { status: 400 });

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
      // A card that changed (a translation landed) is an update, not a birth:
      // nobody gets told twice that a decision is waiting.
      const isNew = url.searchParams.get("kind") !== "updated";
      for (const card of cards) {
        if (!card?.id) continue;
        const { forEveryone, forRecipient } = upsertEvents(card, { isNew });
        for (const ev of forEveryone) this.broadcast(orgId, ev);
        for (const ev of forRecipient) this.sendTo(orgId, card.recipientUserID, ev);
      }
      return new Response(JSON.stringify({ announced: cards.length }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === EVENTS_PATH && request.headers.get("Upgrade") !== "websocket") {
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      let events = [];
      let deliveries = [];
      try { ({ events = [], deliveries = [] } = await request.json()); } catch { return new Response("bad request", { status: 400 }); }
      for (const ev of events) if (ev && typeof ev === "object") this.broadcast(orgId, ev);
      // Events for named people only — a direct conversation's message goes
      // to the two people in it, never the room.
      for (const d of Array.isArray(deliveries) ? deliveries : []) {
        if (d && typeof d.to === "string" && d.event && typeof d.event === "object") this.sendTo(orgId, d.to, d.event);
      }
      return new Response(JSON.stringify({ announced: events.length }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }

    // Somebody was taken out of this workspace. The membership row is already
    // gone, so they cannot join again — this is about the socket they are
    // holding right now, which no later check would ever look at.
    if (url.pathname === EVICT_PATH && request.headers.get("Upgrade") !== "websocket") {
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      let login = null;
      try { ({ login = null } = await request.json()); } catch { return new Response("bad request", { status: 400 }); }
      let evicted = 0;
      if (login) {
        for (const ws of this.state.getWebSockets()) {
          const att = ws.deserializeAttachment();
          if (att?.orgId !== orgId || att?.userId !== login) continue;
          this.refuse(ws, att.agui, "You are no longer a member of this workspace.", "not-a-member");
          evicted += 1;
        }
      }
      return new Response(JSON.stringify({ evicted }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server); // hibernation API
    // Where the socket came from, for the workspace's allowed networks.
    server.serializeAttachment({ orgId, userId: null, agui: false, ip: request.headers.get("cf-connecting-ip") || null });
    return new Response(null, { status: 101, webSocket: client });
  }

  /// One send that cannot take the handler down with it. A socket the
  /// runtime still lists can already be closing — a member removed and
  /// evicted in the same tick, a tab gone mid-broadcast — and `send()` on
  /// it throws "Can't call WebSocket send() after close()", which used to
  /// surface as an uncaught error out of `webSocketClose` and stop the rest
  /// of the room from hearing the event.
  static deliver(ws, text) {
    try {
      if (ws.readyState !== undefined && ws.readyState !== 1) return;
      ws.send(text);
    } catch (err) {
      console.warn("ws send skipped", err?.message || err);
    }
  }

  broadcast(orgId, obj, exclude) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    // A guest hears only what is sent to them by name, and who is online:
    // an org-wide event is the whole workspace's — every card, every
    // public channel — and a guest is in only part of it.
    const forGuests = typeof obj === "object" && obj?.name === "presence";
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && ws !== exclude && (!att.guest || forGuests)) OrgRelay.deliver(ws, text);
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
  refuse(ws, agui, message, code) {
    try {
      ws.send(JSON.stringify(agui ? runError(message, code) : { type: "error", payload: { message, code } }));
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
    // The workspace's webhooks hear a decision made and a decision decided,
    // after the fact and never in its way.
    if ((event.type === "created" || event.type === "decided") && event.snapshot) {
      this.state.waitUntil(emitCard(this.env, orgId, event.snapshot, event.type === "created" ? "card.created" : "card.decided"));
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
  overBudget(userId, jam = false) {
    const now = Date.now();
    // A Jam's signals are many and small, and counted on their own: a call
    // setting up must not use up the budget for everything else.
    const window = jam ? (this.jamWindow ||= new Map()) : (this.messageWindow ||= new Map());
    const seen = window.get(userId);
    if (!seen || now - seen.since > MESSAGE_WINDOW_MS) {
      window.set(userId, { since: now, count: 1 });
      return false;
    }
    seen.count += 1;
    return seen.count > (jam ? JAM_SIGNAL_BUDGET : MESSAGE_BUDGET);
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment() || {};
    const orgId = att.orgId;
    if (!orgId) { ws.close(1008, "no workspace"); return; }
    // Past what the workspace's login rules allow: nothing more on this socket.
    if (att.deadline && Date.now() >= att.deadline) {
      return this.refuse(ws, att.agui, "This workspace asks you to sign in again.", "session-policy");
    }

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
    if (type !== "join" && this.overBudget(att.userId, JAM_TYPES.has(type))) {
      // Told, not closed: a burst is far more often a client bug than an
      // attack, and dropping the socket turns a recoverable moment into a
      // reconnect loop.
      try { ws.send(JSON.stringify(runError("Too many messages. Slow down."))); } catch {}
      return;
    }

    try {
    if (type === "join") {
      const agui = payload.protocol === "agui/1";
      // `join` is the one message exempt from the per-user budget — no user is
      // proved yet — so it gets its own bound instead: a handful of attempts
      // per socket, each of which costs a session lookup and a membership
      // check against D1. Re-joining is allowed inside the bound: it is how a
      // client re-auths with a fresh session without dropping the socket.
      const joins = (att.joins || 0) + 1;
      ws.serializeAttachment({ ...att, joins });
      if (joins > MAX_JOINS_PER_SOCKET) {
        return this.refuse(ws, agui, "Too many join attempts on this connection.");
      }
      // Identity is never taken from the client. `payload.userId` is read only
      // to be discarded: whoever you say you are, you act as the login on your
      // session, in the org that session can prove it belongs to.
      const session = payload.sessionToken ? await getSession(this.db, payload.sessionToken) : null;
      if (!session) {
        return this.refuse(ws, agui, "Sign in to join this organization.", "sign-in-required");
      }
      const access = await authorizeOrgAccess(this.env, session, orgId);
      if (!access.ok) {
        return this.refuse(ws, agui, "You are not a member of this organization.", "not-a-member");
      }
      // The workspace's login rules: refused if outgrown, and closed when the
      // longest a sign-in may last here runs out, however busy the socket.
      const { sessionPolicy, brokenRule, sessionDeadline } = await import("./policy.js");
      const policy = await sessionPolicy(this.db, orgId);
      if (brokenRule(policy, session)) {
        return this.refuse(ws, agui, "This workspace asks you to sign in again.", "session-policy");
      }
      const { ssoDenial } = await import("./sso.js");
      const sso = await ssoDenial(this.env, session, orgId);
      if (sso) return this.refuse(ws, agui, sso.body.message, sso.body.code);
      const { ipDenial } = await import("./governance.js");
      const offNetwork = await ipDenial(this.env, orgId, att.ip);
      if (offNetwork) return this.refuse(ws, agui, offNetwork.body.message, offNetwork.body.code);
      const deadline = sessionDeadline(policy, session);
      if (deadline) {
        const current = await this.state.storage.getAlarm().catch(() => null);
        if (!current || deadline < current) await this.state.storage.setAlarm(deadline).catch(() => {});
      }
      // The legacy dialect is refused rather than half-served. A client that
      // joined without `agui/1` used to get a snapshot and then silence: every
      // broadcast below this line is an AG-UI event, so its feed froze at the
      // moment it connected and looked, from the inside, exactly like a quiet
      // team. Saying "update the app" is the honest version of that.
      if (!agui) {
        return this.refuse(ws, false, "This version is too old to connect. Please update the app.", "client-too-old");
      }

      const userId = access.login;
      const guest = await isGuest(this.db, orgId, session.github_id);
      ws.serializeAttachment({ ...att, joins, userId, githubId: String(session.github_id), agui, authed: true, guest, deadline: deadline || null });
      const store = await loadStore(this.db, orgId);
      // A guest's feed is the decisions they are on, nobody else's.
      if (guest) {
        for (const [owner, cards] of Object.entries(store)) {
          store[owner] = cards.filter((c) => c.recipientUserID === userId || c.senderUserID === userId);
          if (!store[owner].length) delete store[owner];
        }
      }
      const everyContext = await loadContexts(this.db, orgId);
      const contexts = guest ? (everyContext[userId] ? { [userId]: everyContext[userId] } : {}) : everyContext;
      for (const ev of joinEvents(userId, store, contexts)) ws.send(JSON.stringify(ev));
      // Who is already here. Presence otherwise only moves when someone joins
      // or leaves, so a joiner without this sees an empty room until the next
      // event — and a reconnecting client, whose presence set was just reset
      // by the snapshot, would stay that way.
      const online = new Set();
      for (const other of this.state.getWebSockets()) {
        if (other === ws) continue;
        const oatt = other.deserializeAttachment();
        if (oatt?.orgId === orgId && oatt?.authed && oatt.userId) online.add(oatt.userId);
      }
      for (const id of online) {
        for (const ev of presenceEvents(id, "online")) ws.send(JSON.stringify(ev));
      }
      // Once, not twice. Presence went out in both dialects to every socket
      // regardless of which one it spoke, so every client received it as a
      // CUSTOM event and again as a legacy message.
      for (const ev of presenceEvents(userId, "online")) this.broadcast(orgId, ev, ws);
      // Who is talking where, for the channels this person can see.
      for (const ev of await jamStatesFor(this, orgId, userId, String(session.github_id))) ws.send(JSON.stringify(ev));
      return;
    }

    if (JAM_TYPES.has(type)) {
      await handleJamMessage(this, ws, ws.deserializeAttachment() || att, type, payload || {});
      return;
    }

    // Somebody is using the app on this socket (typing, clicking, reading),
    // not merely holding it open: their phone is not pushed about what they
    // are here to see. Written at most every thirty seconds per socket.
    if (type === "activity") {
      const now = Date.now();
      if (!att.activityAt || now - att.activityAt >= 30_000) {
        ws.serializeAttachment({ ...att, activityAt: now });
        const client = payload.client === "ios" ? "ios" : "web";
        await noteActivity(this.db, att.userId, client, now).catch(() => {});
      }
      return;
    }

    if (type === "tool_result") {
      const content = typeof payload.content === "string" ? JSON.parse(payload.content) : payload.content;
      await this.applyAndPublish(orgId, { ...content, actorUserID: att.userId }, payload.toolCallId, att.userId, att.githubId);
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
      for (const ev of forEveryone) this.sendTo(orgId, card.recipientUserID, ev);
      for (const ev of forRecipient) this.sendTo(orgId, card.recipientUserID, ev);
      // Counted. How often a decision has to be asked about twice is one of
      // the few numbers that says whether the feed is doing its job.
      await this.log(orgId, { cardId: card.id, type: "nudged", actorUserId: att.userId, snapshot: card });
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
      if (type === "card_created") {
        // A new card is new. `saveCard` is an upsert, and nothing here asked
        // whether the id was already taken — so any member could replace any
        // card in the org, decision and all, by reusing its id: "approved by
        // alice", written by somebody else, logged as `created`. The same
        // sender re-sending the same id is an outbox replaying after a lost
        // ack, and that is answered with silence rather than an error.
        if (existing) {
          if (existing.senderUserID !== att.userId) {
            ws.send(JSON.stringify(runError("That card already exists.")));
          }
          return;
        }
        // And a new card arrives undecided. A decision is the recipient's to
        // make, over `tool_result` or `card_updated`, after the card exists.
        if (card.decision !== undefined || (card.status !== undefined && card.status !== "pending")) {
          ws.send(JSON.stringify(runError("A new card cannot arrive already decided.")));
          return;
        }
        // A business is a slug on the card and a row in the table. A name
        // nobody has typed before becomes a business here — the taxonomy is
        // built by using it, not designed up front. Filed only once the card
        // has passed the checks above, so a refused card creates nothing.
        if (card.business !== undefined) card.business = await this.fileUnder(orgId, card.business, att.githubId);
        // A directory ref is scoped to this org and carries no email address.
        // Resolve it server-side before the existing membership and sender
        // checks. Legacy clients may continue sending a login.
        delete card.recipientMemberRef;
        delete card.recipientName;
        // Translations are the relay's to write. One the sender supplied is
        // words the recipient would read as the card that are not the card.
        delete card.localized;
        // And a daily report's draft is the Worker's to make: a client cannot
        // hand someone a "draft" that posts in their name.
        delete card.dailyReport;
        if (card.recipientUserID.startsWith("member:")) {
          const member = (await listMembers(this.db, orgId, att.githubId))
            .find(m => `member:${m.ref}` === card.recipientUserID);
          if (!member) {
            ws.send(JSON.stringify(runError("That person is not in this workspace.")));
            return;
          }
          card.recipientMemberRef = member.ref;
          card.recipientName = member.name;
          card.recipientUserID = member.login;
        }
        // Anyone in the org — and the org is the part that was never checked.
        // The sender is stamped below and cannot be forged; the recipient came
        // straight off the wire, so a card could be addressed to somebody in a
        // different workspace entirely. It would sit in this one, where they
        // can never join to decide it, and `notifyCard` resolves a recipient by
        // login with no idea which org asked — so the title and summary on that
        // card go out as a push, a web push and an email to a person who has
        // never heard of this team.
        if (!(await isOrgMemberLogin(this.db, orgId, card.recipientUserID))) {
          ws.send(JSON.stringify(runError("That person is not in this workspace.")));
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
        // Away, with somebody named to decide meanwhile: the card goes to
        // them, and says whose it would have been.
        try {
          await redirectIfAway(await listMembers(this.db, orgId, att.githubId), card);
        } catch (err) {
          console.error("away redirect failed", err?.message || err);
        }
        // A standing yes from the recipient decides it on arrival, and the
        // card says so.
        try {
          await applyAutoRule(this.db, orgId, card);
        } catch (err) {
          console.error("auto rule failed", err?.message || err);
        }
      } else {
        // An update names a card the relay has. Without this, an unknown id
        // made `card_updated` a second way to create a card — one that did
        // not stamp the sender or check the recipient, so a "decided" card
        // could carry any login on the platform as its sender and have the
        // relay push, web-push and email that person, in any org, with text
        // the attacker wrote.
        if (!existing) {
          ws.send(JSON.stringify(runError("Unknown card.")));
          return;
        }
        if (card.business !== undefined) card.business = await this.fileUnder(orgId, card.business, att.githubId);
        // A card belongs to whoever has to decide it. Only they may change it,
        // and rewriting the field must not be a way to hand it off — delegation
        // is a new card, not a moved one.
        const owner = existing.recipientUserID;
        if (owner !== att.userId) {
          ws.send(JSON.stringify(runError("Only the recipient can update this decision.")));
          return;
        }
        card.recipientUserID = owner;
        // Who asked is a fact about the card's creation; it does not change
        // on an update, and it is not the updater's to set.
        card.senderUserID = existing.senderUserID;
        if (card.decision?.action) card.decision.actorUserID = att.userId;
        // The iOS client republishes its whole local copy on a decision, and
        // that copy does not carry what the relay added after the card was
        // created — the translation, the business, who asked, what the AI
        // advised. A client that does not know a field must not erase it.
        if (existing) {
          // The translations are the stored ones, whatever the client's copy
          // says: a phone republishing what it loaded an hour ago must not
          // drop the language somebody else asked for since.
          if (existing.localized !== undefined) card.localized = existing.localized;
          else delete card.localized;
          // A daily report's state is the Worker's: posted only through Post.
          if (existing.dailyReport !== undefined) card.dailyReport = existing.dailyReport;
          else delete card.dailyReport;
          // An unposted draft is not put away by deciding it — from any
          // client, however old: the only way off the feed is to post it.
          if (existing.dailyReport?.status === "draft" && card.decision?.action) {
            ws.send(JSON.stringify(runError(DRAFT_MUST_POST)));
            return;
          }
          for (const field of ["business", "requestedBy", "recommendation", "recipientMemberRef", "recipientName", "report", "proposal", "reminder", "autoApproved", "coveringFor"]) {
            if (card[field] === undefined && existing[field] !== undefined) card[field] = existing[field];
          }
        }
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
        // Only the update that made the decision: the phone republishes a
        // decided card whole whenever it touches it, and learning from it
        // again was another model call and another copy of the same rule.
        const isNew = !existing?.decision?.action
          || existing.decision.action !== decision.action
          || existing.decision.decidedAt !== decision.decidedAt;
        if (isNew) this.state.waitUntil(this.afterDecision(orgId, card, att.userId, att.githubId));
      }
      const { forEveryone, forRecipient } = upsertEvents(card, { isNew: type === "card_created" });
      for (const ev of forEveryone) this.broadcast(orgId, ev);
      for (const ev of forRecipient) this.sendTo(orgId, card.recipientUserID, ev);
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
      // Whoever the sender named with an @ hears too — the recipient already
      // did, above, and the sender knows. Refs from the client, resolved
      // against the real member list: a ref that names nobody names nobody.
      if (type === "card_created" && Array.isArray(card.mentions) && card.mentions.length && anyChannelConfigured(this.env)) {
        this.state.waitUntil(this.notifyMentioned(orgId, card, att.userId, att.githubId));
      }
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
      for (const ev of forEveryone) this.broadcast(orgId, ev);
      return;
    }

    if (type === "card_deleted") {
      if (!payload.cardId) return;
      const doomed = await getCard(this.db, orgId, payload.cardId);
      // Whoever it was for may clear it away; whoever asked may take the ask
      // back while nobody has answered it.
      const pending = doomed && (doomed.status || "pending") === "pending" && !doomed.decision;
      if (doomed && doomed.recipientUserID !== att.userId && !(pending && doomed.senderUserID === att.userId)) {
        ws.send(JSON.stringify(runError("Only the recipient, or its sender while it waits, can delete this decision.")));
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
  async notifyMentioned(orgId, card, authorLogin, authorGithubId) {
    try {
      const members = await listMembers(this.db, orgId, null);
      const wanted = new Set(card.mentions.map((m) => String(m).replace(/^member:/, "")).slice(0, 10));
      const told = new Set([authorLogin, card.recipientUserID]);
      const who = { author: authorLogin, name: card.requestedBy?.name || null, text: card.title || card.sourceInstruction || "" };
      for (const m of members) {
        if (!wanted.has(m.ref) && !wanted.has(m.login)) continue;
        if (told.has(m.login)) continue;
        told.add(m.login);
        // In the language of the one mentioned, which need not be the
        // recipient's. No announce: this is the room, and it does not call
        // itself; the words are stored for the next snapshot.
        await notifyCard(this.env, {
          card, kind: "mentioned", toLogin: m.login, comment: who,
          orgId, payerGithubId: authorGithubId, announce: false,
        });
      }
    } catch (err) {
      console.error("mention notify failed", err?.message || err);
    }
  }

  async deliver(orgId, card, { kind, excludeLogin, translate, senderGithubId }) {
    const provider = await providerFor(this.env, orgId);
    const canNotify = anyChannelConfigured(this.env);
    const github = await getWorkspaceGitHub(this.db, orgId);
    // Nothing to enrich with, nowhere to write and nobody to tell: not a
    // single query more. This runs after the broadcast, in waitUntil, and a
    // database round trip nobody needed is one that can outlive the request
    // that started it.
    if (!provider && !canNotify && !github) return;

    let current = card;
    // The workspace's repository, when it has one: a new card is an issue,
    // a decided one is that issue brought up to date and closed. The card
    // carries the issue back to every client.
    if (github?.token) {
      try {
        const synced = await syncCardToGitHub(this.env, orgId, current);
        if (synced && (synced.githubIssueNumber !== current.githubIssueNumber || synced.githubIssueURL !== current.githubIssueURL)) {
          current = synced;
          await saveCard(this.db, orgId, current);
          const { forEveryone } = upsertEvents(current, { isNew: false });
          for (const ev of forEveryone) this.broadcast(orgId, ev);
        }
      } catch (err) {
        console.error("github sync failed", err?.message || err);
      }
    }
    try {
      if (translate && provider) {
        const allowance = senderGithubId
          ? await allowanceFor(this.env, orgId, { githubId: String(senderGithubId) })
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
          await saveCard(this.db, orgId, current);
          const { forEveryone } = upsertEvents(current, { isNew: false });
          for (const ev of forEveryone) this.broadcast(orgId, ev);
        }
      }
    } catch (err) {
      // A translation or a filing that fails is a card read in the sender's
      // language, or one without a business — not a card nobody was told about.
      console.error("deliver enrichment failed", err?.message || err);
    }
    // What the enrichment cost, on the sender's account.
    await settleUsage(this.db, provider, { orgId, githubId: senderGithubId });
    if (!canNotify) return;
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

  /// What a decision teaches and what it settles, after it is made and
  /// broadcast: a proposal approved becomes a routine, and a reason given
  /// becomes a rule in the team's playbook. Never awaited by the decision;
  /// never able to fail it.
  async afterDecision(orgId, card, actorLogin, actorGithubId) {
    try {
      if (card?.proposal) await settleProposal(this.env, orgId, card);
      else await learnFromDecision(this.env, { orgId, card, actorLogin, actorGithubId });
    } catch (err) {
      console.error("after decision failed", err?.message || err);
    }
  }

  async applyAndPublish(orgId, content, toolCallId, actorUserId, actorGithubId) {
    const store = await loadStore(this.db, orgId);
    if (actorUserId && content?.cardId) {
      const target = await getCard(this.db, orgId, content.cardId);
      if (target && target.recipientUserID !== actorUserId) {
        throw new Error("Only the recipient can decide this card.");
      }
      if (target?.dailyReport?.status === "draft") throw new Error(DRAFT_MUST_POST);
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
      this.state.waitUntil(this.afterDecision(orgId, out.card, actorUserId, actorGithubId));
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
      for (const ev of forEveryone) this.broadcast(orgId, ev);
    }
    if (toolCallId) this.broadcast(orgId, toolCallResult(toolCallId, out.card));
  }

  /// A workspace's login rules end sockets at their deadline: each one past
  /// it is told why and closed, and the next deadline is set.
  async alarm() {
    const now = Date.now();
    let next = null;
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (!att.deadline) continue;
      if (att.deadline <= now) this.refuse(ws, att.agui, "This workspace asks you to sign in again.", "session-policy");
      else if (!next || att.deadline < next) next = att.deadline;
    }
    if (next) await this.state.storage.setAlarm(next).catch(() => {});
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.userId) {
      for (const ev of presenceEvents(att.userId, "offline")) this.broadcast(att.orgId, ev, ws);
    }
    // A closed tab has left its Jam.
    if (att.jam) {
      try { await leaveJam(this, ws, att, { closing: true }); } catch (err) { console.error("jam leave failed", err?.message || err); }
    }
  }

  webSocketError(ws, err) {
    console.error("ws error", err);
  }
}
