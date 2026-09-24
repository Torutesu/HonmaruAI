import { getSession, isMember, getUserByGithubId, saveCard } from "./db.js";
import { enforce } from "./ratelimit.js";
import { listMembers } from "./team.js";
import { resolveMentions } from "./threads.js";
import { appendCardEvent } from "./events.js";
import { announceCards, announceEvents, announceTo } from "./announce.js";
import { notifyCard, anyChannelConfigured } from "./notify.js";
import { custom as customEvent } from "./agui/events.js";
import {
  resolveChannel, listMessages, postMessage, getMessage, linkCard, transcriptUpTo, channelActivity,
  viewOf, asksTheAI, withoutAI, MAX_MESSAGE_CHARS,
  present, listThread, listPins, editMessage, deleteMessage, toggleReaction, setPinned,
  markRead, readsFor, activityFeed, searchMessages,
} from "./channels.js";
import { safe } from "./log.js";
import { sha256Hex } from "./auth.js";

// The routes for talking in a channel, and for turning what was said into
// a decision. The decision goes through `/ai/route` itself — the same
// router, the same allowance, the same playbook and research as anything a
// person tells their AI — with the conversation handed in as context.

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key, authorization, mcp-session-id, mcp-protocol-version",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS_HEADERS },
  });
}

async function caller(env, request, orgId) {
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return { denied: json({ message: "Please sign in." }, 401) };
  if (!orgId || typeof orgId !== "string") return { denied: json({ message: "orgId is required" }, 400) };
  if (!(await isMember(env.DB, orgId, session.github_id))) return { denied: json({ message: "not a member of this org" }, 403) };
  const user = await getUserByGithubId(env.DB, session.github_id);
  if (!user?.login) return { denied: json({ message: "Please sign in." }, 401) };
  return { session, user: { ...user, github_id: session.github_id } };
}

/// The caller, the channel they named, and how they see it — or why not.
async function inChannel(env, request, { orgId, channel }) {
  const who = await caller(env, request, orgId);
  if (who.denied) return who;
  const members = await listMembers(env.DB, orgId, who.session.github_id);
  const resolved = await resolveChannel(env.DB, orgId, who.user, channel, members);
  if (!resolved) return { denied: json({ message: "No such channel." }, 404) };
  return { who, members, resolved, view: viewOf(resolved.key, who.user.login, members) };
}

/// Tell whoever can see a channel about a message in it, each in their own
/// terms: the room for a business, the two people for a direct one. The
/// same event carries a new message, an edit, a deletion, a reaction, a
/// pin, and a thread's new count — the browser replaces by id.
async function broadcast(env, orgId, resolved, row, members) {
  const fresh = (await getMessage(env.DB, orgId, row.id)) || row;
  if (resolved.kind === "business") {
    const [message] = await present(env.DB, orgId, [fresh], null, resolved.key, members);
    await announceEvents(env, orgId, [customEvent("channel_message", { message })]);
    return;
  }
  await announceTo(env, orgId, await Promise.all(resolved.logins.map(async (login) => {
    const [message] = await present(env.DB, orgId, [fresh], login, viewOf(resolved.key, login, members), members);
    return { to: login, event: customEvent("channel_message", { message }) };
  })));
}

/// A reply changes its parent too: the count and faces under it.
async function broadcastWithParent(env, orgId, resolved, row, members) {
  await broadcast(env, orgId, resolved, row, members);
  if (row.parent_id) {
    const parent = await getMessage(env.DB, orgId, row.parent_id);
    if (parent) await broadcast(env, orgId, resolved, parent, members);
  }
}

/// Make a decision from a message: route it with the conversation as
/// context, save the card, and say so in the channel. Never throws; a
/// failure is said in the channel too, where the person is looking.
export async function decideFromMessage(env, { orgId, session, user, resolved, row, members, route, locale }) {
  // What the AI is doing, as it does it — shown in the conversation so a
  // person sees reading, then routing, then writing, not one long wait.
  const progress = async (step, extra = {}) => {
    try {
      const payload = (view) => customEvent("channel_ai_progress", { channel: view, parentId: row.parent_id || null, messageId: row.id, step, ...extra });
      if (resolved.kind === "business") await announceEvents(env, orgId, [payload(resolved.key)]);
      else await announceTo(env, orgId, resolved.logins.map((login) => ({ to: login, event: payload(viewOf(resolved.key, login, members)) })));
    } catch (err) {
      console.error("progress event failed", safe(err?.message));
    }
  };
  // Asked in a thread, the AI answers in that thread.
  const say = async (body, cardId = null) => {
    const out = await postMessage(env.DB, { orgId, key: resolved.key, authorLogin: null, body, kind: "ai", cardId, parentId: row.parent_id || null });
    if (out.row) await broadcastWithParent(env, orgId, resolved, out.row, members);
  };
  try {
    const instruction = withoutAI(row.body) || row.body;
    await progress("reading");
    const transcript = await transcriptUpTo(env.DB, orgId, resolved.key, row.created_at);
    const where = resolved.kind === "business" ? `#${resolved.slug}` : "a direct conversation";
    // The conversation, newest last and trimmed from the old end: the
    // router reads it as the sender's context.
    let context = `Conversation in ${where} leading to this request (oldest first):\n${transcript.join("\n")}`;
    if (context.length > 3800) context = `…${context.slice(context.length - 3800)}`;

    // Whoever the message names decides; in a direct conversation with
    // nobody named, the other person does.
    const named = resolveMentions(instruction, members).filter((m) => m.login !== user.login);
    const mentions = named.length ? named.map((m) => m.ref) : (resolved.kind === "dm" ? [resolved.other.ref] : []);
    await progress("routing");
    const res = await route({
      text: instruction.slice(0, 4000),
      sender: { id: user.login, role: "member" },
      readerLanguage: locale,
      orgId,
      organization: { orgId },
      senderContext: context,
      ...(mentions.length ? { mentions } : {}),
    });
    const routed = await res.json().catch(() => ({}));
    if (!res.ok) {
      await say(locale === "ja" ? `決定カードにできませんでした: ${routed.message || "もう一度試してください。"}` : `Could not make that a decision: ${routed.message || "try again."}`);
      await progress("failed");
      return null;
    }
    // A recipient the router named must be a member here; anything else
    // comes back to the person who asked.
    const recipient = members.find((m) => m.login === routed.recipientUserID)
      || members.find((m) => `member:${m.ref}` === routed.recipientUserID)
      || members.find((m) => m.login === user.login);
    await progress("writing", { recipientName: recipient.login === user.login ? null : recipient.name });
    const now = new Date().toISOString();
    const card = {
      id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: routed.cardType || "approval",
      format: routed.cardType === "notification" ? "fyi" : "approve",
      status: "pending",
      recipientUserID: recipient.login,
      senderUserID: user.login,
      // Without a model the router's title is a label ("Approval needed");
      // the person's own words say more.
      title: String((routed.routedBy === "fallback" || routed.routedBy === "jev" || routed.routedBy === "jev-unsure" ? instruction : routed.title) || instruction).slice(0, 200),
      summary: String(routed.summary || "").slice(0, 1500),
      context: String(routed.context || "").slice(0, 6000),
      priority: routed.priority || "medium",
      routingReason: routed.routingReason || "",
      agentRoute: routed.agentRoute || "",
      createdAt: now,
      sourceInstruction: instruction.slice(0, 1000),
      ...(resolved.kind === "business" ? { business: resolved.slug } : (routed.business ? { business: routed.business } : {})),
      ...(routed.recommendation ? { recommendation: routed.recommendation } : {}),
      requestedBy: { login: user.login, name: user.name || undefined, quote: instruction.slice(0, 600) },
      fromMessage: row.id,
    };
    await saveCard(env.DB, orgId, card);
    await appendCardEvent(env.DB, orgId, { cardId: card.id, type: "created", actorUserId: user.login, note: `from ${where}`, snapshot: card });
    await linkCard(env.DB, orgId, row.id, card.id);
    await announceCards(env, orgId, [card]);
    if (anyChannelConfigured(env) && recipient.login !== user.login) {
      await notifyCard(env, { card, kind: "created", excludeLogin: user.login }).catch((err) => console.error("channel notify failed", safe(err?.message)));
    }
    const who = recipient.login === user.login ? (locale === "ja" ? "あなた" : "you") : recipient.name;
    // Why this person: the router's own one line, so the choice is visible
    // rather than taken on trust.
    const why = String(routed.routingReason || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const whyLine = why ? (locale === "ja" ? `\n理由: ${why}` : `\nWhy: ${why}`) : "";
    await say((locale === "ja" ? `${who}への決定カードにしました: ${card.title}` : `Made this a decision for ${who}: ${card.title}`) + whyLine, card.id);
    await progress("done", { cardId: card.id });
    return card;
  } catch (err) {
    console.error("decide from message failed", safe(err?.message));
    await progress("failed");
    await say(locale === "ja" ? "決定カードにできませんでした。もう一度試してください。" : "Could not make that a decision. Try again.").catch(() => {});
    return null;
  }
}

/// `route(body)` is `/ai/route`, called in-process with this request's
/// session. `after(work)` runs work past the response.
export async function handleChannels(request, env, url, { route, after }) {
  const path = url.pathname;

  if (path === "/channels" && request.method === "GET") {
    const orgId = url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, orgId, who.session.github_id);
    return json({
      activity: await channelActivity(env.DB, orgId, who.user.login, members),
      // `loginHash` lets a browser tell which member a card it already holds
      // is from — cards carry logins — without being handed anyone's login.
      members: await Promise.all(members.map(async (m) => ({
        ref: m.ref, name: m.name, title: m.title || m.role, mine: m.mine,
        loginHash: (await sha256Hex(m.login)).slice(0, 16),
      }))),
      maxChars: MAX_MESSAGE_CHARS,
      // Where you are up to in each conversation, from whichever device.
      reads: await readsFor(env.DB, orgId, who.user.login, members),
    });
  }

  // "I have read this far." A conversation, or the Activity inbox.
  if (path === "/channels/read" && request.method === "POST") {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    if (body.channel === "activity") {
      const who = await caller(env, request, body.orgId);
      if (who.denied) return who.denied;
      return json({ lastReadAt: await markRead(env.DB, body.orgId, who.user.login, "activity", body.at) });
    }
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    return json({ lastReadAt: await markRead(env.DB, body.orgId, ctx.who.user.login, ctx.resolved.key, body.at) });
  }

  // Activity: what named you, and replies in your threads.
  if (path === "/channels/activity" && request.method === "GET") {
    const orgId = url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, orgId, who.session.github_id);
    return json(await activityFeed(env.DB, orgId, who.user.login, members));
  }

  // Search what was said, with Slack's filters.
  if (path === "/channels/search" && request.method === "GET") {
    const orgId = url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, orgId, who.session.github_id);
    return json(await searchMessages(env.DB, orgId, who.user.login, members, url.searchParams.get("q") || ""));
  }

  if (path === "/channels/messages" && (request.method === "GET" || request.method === "POST")) {
    if (request.method === "POST") {
      const limited = await enforce(env, request, "chat");
      if (limited) return limited;
    }
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (request.method === "POST" && (!body || typeof body !== "object")) return json({ message: "Invalid JSON body." }, 400);
    const orgId = request.method === "GET" ? url.searchParams.get("orgId") : body.orgId;
    const channel = request.method === "GET" ? url.searchParams.get("channel") : body.channel;
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, orgId, who.session.github_id);
    const resolved = await resolveChannel(env.DB, orgId, who.user, channel, members);
    if (!resolved) return json({ message: "No such channel." }, 404);
    const view = viewOf(resolved.key, who.user.login, members);
    if (request.method === "GET") {
      const before = url.searchParams.get("before") || undefined;
      return json({ messages: await listMessages(env.DB, orgId, resolved, who.user.login, view, members, { before }) });
    }
    const parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : null;
    const out = await postMessage(env.DB, { orgId, key: resolved.key, authorLogin: who.user.login, body: typeof body.body === "string" ? body.body : "", parentId });
    if (out.error) return json({ message: out.error }, 400);
    const wantsDecision = body.decide === true || asksTheAI(out.row.body);
    const locale = who.user.locale || "en";
    after(async () => {
      await broadcastWithParent(env, orgId, resolved, out.row, members);
      if (wantsDecision) {
        await decideFromMessage(env, { orgId, session: who.session, user: who.user, resolved, row: out.row, members, route, locale });
      }
    });
    // What you said, you have read.
    if (!parentId) await markRead(env.DB, orgId, who.user.login, resolved.key, out.row.created_at);
    const [message] = await present(env.DB, orgId, [out.row], who.user.login, view, members);
    return json({ message, deciding: wantsDecision }, 201);
  }

  // Edit or unsend your own message.
  if (path === "/channels/messages" && (request.method === "PUT" || request.method === "DELETE")) {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || typeof body.messageId !== "string") return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    const current = await getMessage(env.DB, body.orgId, body.messageId);
    if (!current || current.channel !== ctx.resolved.key) return json({ message: "No such message." }, 404);
    const out = request.method === "PUT"
      ? await editMessage(env.DB, { orgId: body.orgId, id: body.messageId, authorLogin: ctx.who.user.login, body: body.body })
      : await deleteMessage(env.DB, { orgId: body.orgId, id: body.messageId, authorLogin: ctx.who.user.login });
    if (out.error) return json({ message: out.error }, out.status || 400);
    after(() => broadcastWithParent(env, body.orgId, ctx.resolved, out.row, ctx.members));
    const [message] = await present(env.DB, body.orgId, [out.row], ctx.who.user.login, ctx.view, ctx.members);
    return json({ message });
  }

  // A thread: the message and its replies.
  if (path === "/channels/thread" && request.method === "GET") {
    const orgId = url.searchParams.get("orgId");
    const ctx = await inChannel(env, request, { orgId, channel: url.searchParams.get("channel") });
    if (ctx.denied) return ctx.denied;
    const thread = await listThread(env.DB, orgId, ctx.resolved.key, url.searchParams.get("messageId") || "", ctx.who.user.login, ctx.view, ctx.members);
    if (!thread) return json({ message: "No such thread." }, 404);
    return json(thread);
  }

  // A reaction, on or off.
  if (path === "/channels/reactions" && request.method === "POST") {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || typeof body.messageId !== "string") return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    const current = await getMessage(env.DB, body.orgId, body.messageId);
    if (!current || current.channel !== ctx.resolved.key) return json({ message: "No such message." }, 404);
    const out = await toggleReaction(env.DB, { orgId: body.orgId, id: body.messageId, login: ctx.who.user.login, emoji: body.emoji });
    if (out.error) return json({ message: out.error }, out.status || 400);
    after(() => broadcast(env, body.orgId, ctx.resolved, out.row, ctx.members));
    const [message] = await present(env.DB, body.orgId, [out.row], ctx.who.user.login, ctx.view, ctx.members);
    return json({ message });
  }

  // Pins: what a channel keeps at hand.
  if (path === "/channels/pins" && (request.method === "GET" || request.method === "POST")) {
    const body = request.method === "POST" ? await request.json().catch(() => null) : { orgId: url.searchParams.get("orgId"), channel: url.searchParams.get("channel") };
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    if (request.method === "GET") {
      return json({ messages: await listPins(env.DB, body.orgId, ctx.resolved.key, ctx.who.user.login, ctx.view, ctx.members) });
    }
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const current = typeof body.messageId === "string" ? await getMessage(env.DB, body.orgId, body.messageId) : null;
    if (!current || current.channel !== ctx.resolved.key) return json({ message: "No such message." }, 404);
    const out = await setPinned(env.DB, { orgId: body.orgId, id: body.messageId, login: ctx.who.user.login, pinned: body.pinned !== false });
    if (out.error) return json({ message: out.error }, out.status || 400);
    after(() => broadcast(env, body.orgId, ctx.resolved, out.row, ctx.members));
    const [message] = await present(env.DB, body.orgId, [out.row], ctx.who.user.login, ctx.view, ctx.members);
    return json({ message });
  }

  // Any message, afterwards: "make this a decision".
  if (path === "/channels/decide" && request.method === "POST") {
    const limited = await enforce(env, request, "ai/route");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const who = await caller(env, request, body.orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, body.orgId, who.session.github_id);
    const resolved = await resolveChannel(env.DB, body.orgId, who.user, body.channel, members);
    if (!resolved) return json({ message: "No such channel." }, 404);
    const row = typeof body.messageId === "string" ? await getMessage(env.DB, body.orgId, body.messageId) : null;
    if (!row || row.channel !== resolved.key || row.kind !== "message") return json({ message: "No such message." }, 404);
    if (row.card_id) return json({ message: "That message is already a decision.", cardId: row.card_id }, 409);
    const locale = who.user.locale || "en";
    after(() => decideFromMessage(env, { orgId: body.orgId, session: who.session, user: who.user, resolved, row, members, route, locale }));
    return json({ deciding: true }, 202);
  }
  return null;
}
