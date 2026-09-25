import { getSession, isMember, getUserByGithubId, saveCard, getCard, listBusinesses } from "./db.js";
import { claimDraft, releaseDraft, postedCard } from "./dailyReport.js";
import { enforce } from "./ratelimit.js";
import { listMembers } from "./team.js";
import { resolveMentions } from "./threads.js";
import { appendCardEvent } from "./events.js";
import { announceCards, announceEvents, announceTo } from "./announce.js";
import { localizeForRecipient } from "./localize.js";
import { loadCopy } from "./copy.js";
import { serverText } from "./serverCopy.js";
import { notifyCard, anyChannelConfigured } from "./notify.js";
import { custom as customEvent } from "./agui/events.js";
import {
  resolveChannel, listMessages, postMessage, getMessage, linkCard, transcriptUpTo, channelActivity,
  viewOf, asksTheAI, withoutAI, MAX_MESSAGE_CHARS,
  present, listThread, listPins, editMessage, deleteMessage, toggleReaction, setPinned,
  markRead, readsFor, activityFeed, searchMessages,
} from "./channels.js";
import { safe } from "./log.js";
import { emitMessage, emitCard } from "./webhooks.js";
import { sha256Hex } from "./auth.js";
import { applyAutoRule, listAutoRules, addAutoRule, removeAutoRule } from "./autorules.js";
import { setStatus, rememberTimezone, redirectIfAway, setChannelPref, prefsFor, memberProfile } from "./people.js";
import { scheduleMessage, listScheduled, cancelScheduled, saveForLater, listSaved, finishSaved } from "./later.js";
import { channelDetails, setDescription, channelRow } from "./channelDetails.js";
import { channelJournal, forgetJournalDay, validDay, validZone } from "./journal.js";
import { providerFor } from "./orgAI.js";
import { allowanceFor } from "./gate.js";
import { settleUsage } from "./ledger.js";
import { readCapped } from "./media.js";
import { uploadFile, attachFiles, claimable, dropFiles } from "./files.js";
import { accessFor, audienceOf, groupFor, groupsOf, addMembers, removeMember, membersOf, MAX_GROUP } from "./access.js";
import {
  MAX_RECORDING_BYTES, recordingType, transcribe, jamNotes, recordingMessage, serveRecording, minutesBetween,
} from "./jam.js";

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
/// terms: the room for a public channel, the members of a closed one. The
/// same event carries a new message, an edit, a deletion, a reaction, a
/// pin, and a thread's new count — the browser replaces by id.
async function broadcast(env, orgId, resolved, row, members) {
  const fresh = (await getMessage(env.DB, orgId, row.id)) || row;
  if (resolved.kind === "business" && !resolved.private) {
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
export async function broadcastWithParent(env, orgId, resolved, row, members) {
  await broadcast(env, orgId, resolved, row, members);
  if (row.parent_id) {
    const parent = await getMessage(env.DB, orgId, row.parent_id);
    if (parent) await broadcast(env, orgId, resolved, parent, members);
  }
}

const flat = (text) => String(text || "").replace(/\s+/g, " ").trim();
const sameWords = (a, b) => Boolean(flat(a)) && flat(a) === flat(b);

/// Make a decision from a message: route it with the conversation as
/// context, save the card, and say so in the channel. Never throws; a
/// failure is said in the channel too, where the person is looking.
export async function decideFromMessage(env, { orgId, session, user, resolved, row, members, route, locale, clipped = null }) {
  // Everything said back in the channel is said in the asker's language.
  locale = await loadCopy(env, locale || "en", { orgId });
  // What the AI is doing, as it does it — shown in the conversation so a
  // person sees reading, then routing, then writing, not one long wait.
  const progress = async (step, extra = {}) => {
    try {
      const payload = (view) => customEvent("channel_ai_progress", { channel: view, parentId: row.parent_id || null, messageId: row.id, step, ...extra });
      if (resolved.kind === "business" && !resolved.private) await announceEvents(env, orgId, [payload(resolved.key)]);
      else await announceTo(env, orgId, resolved.logins.map((login) => ({ to: login, event: payload(viewOf(resolved.key, login, members)) })));
    } catch (err) {
      console.error("progress event failed", safe(err?.message));
    }
  };
  // Asked in a thread, the AI answers in that thread.
  const say = async (body, cardId = null) => {
    const out = await postMessage(env.DB, { orgId, key: resolved.key, authorLogin: null, body, kind: "ai", cardId, parentId: row.parent_id || null });
    if (out.row) {
      await broadcastWithParent(env, orgId, resolved, out.row, members);
      await emitMessage(env, orgId, out.row);
    }
  };
  try {
    const instruction = withoutAI(row.body) || row.body;
    await progress("reading");
    const where = resolved.kind === "business" ? `#${resolved.slug}` : "a direct conversation";
    // The conversation, newest last and trimmed from the old end: the
    // router reads it as the sender's context — or, for a clip, exactly the
    // messages the person picked, from wherever they were.
    let context;
    if (clipped) {
      context = `Messages the requester clipped together as context (oldest first):\n${clipped.join("\n")}`;
    } else {
      const transcript = await transcriptUpTo(env.DB, orgId, resolved.key, row.created_at);
      context = `Conversation in ${where} leading to this request (oldest first):\n${transcript.join("\n")}`;
    }
    if (context.length > 3800) context = `…${context.slice(context.length - 3800)}`;

    // Whoever the message names decides; in a direct conversation with
    // nobody named, the other person does.
    const named = resolveMentions(instruction, members).filter((m) => m.login !== user.login);
    const mentions = named.length ? named.map((m) => m.ref) : (resolved.kind === "dm" ? [resolved.other.ref] : []);
    await progress("routing");
    const res = await route({
      text: instruction.slice(0, 4000),
      // The name the person goes by: without it the router falls back to
      // one made from the login, and the card says "Torubj0904から".
      sender: { id: user.login, name: user.name || undefined, role: "member" },
      readerLanguage: locale,
      orgId,
      organization: { orgId },
      senderContext: context,
      ...(mentions.length ? { mentions } : {}),
    });
    const routed = await res.json().catch(() => ({}));
    if (!res.ok) {
      await say(routed.message ? serverText(locale, "channel.failedBecause", { reason: routed.message }) : serverText(locale, "channel.failed"));
      await progress("failed");
      return null;
    }
    // A recipient the router named must be a member here; anything else
    // comes back to the person who asked.
    const recipient = members.find((m) => m.login === routed.recipientUserID)
      || members.find((m) => `member:${m.ref}` === routed.recipientUserID)
      || members.find((m) => m.login === user.login);
    await progress("writing", { recipientName: recipient.login === user.login ? null : recipient.name });
    let covering = null;
    const now = new Date().toISOString();
    // Without a model the router's title is a label ("Approval needed");
    // the person's own words say more.
    const title = String((routed.routedBy === "fallback" || routed.routedBy === "jev" || routed.routedBy === "jev-unsure" ? instruction : routed.title) || instruction).slice(0, 200);
    const card = {
      id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: routed.cardType || "approval",
      format: routed.cardType === "notification" ? "fyi" : "approve",
      status: "pending",
      recipientUserID: recipient.login,
      senderUserID: user.login,
      title,
      // Without a model the summary is the instruction again, which is the
      // title already: said once.
      summary: sameWords(routed.summary, title) ? "" : String(routed.summary || "").slice(0, 1500),
      context: String(routed.context || "").slice(0, 6000),
      priority: routed.priority || "medium",
      routingReason: routed.routingReason || "",
      agentRoute: routed.agentRoute || "",
      createdAt: now,
      sourceInstruction: instruction.slice(0, 1000),
      ...(resolved.kind === "business" ? { business: resolved.slug } : (routed.business ? { business: routed.business } : {})),
      ...(routed.recommendation ? { recommendation: routed.recommendation } : {}),
      requestedBy: { login: user.login, name: user.name || undefined, avatarUrl: user.avatar_url || undefined, quote: instruction.slice(0, 600) },
      fromMessage: row.id,
    };
    // Away, with somebody deciding meanwhile: it goes to them.
    covering = await redirectIfAway(members, card);
    const rule = await applyAutoRule(env.DB, orgId, card).catch(() => null);
    await saveCard(env.DB, orgId, card);
    await appendCardEvent(env.DB, orgId, { cardId: card.id, type: "created", actorUserId: user.login, note: `from ${where}`, snapshot: card });
    await linkCard(env.DB, orgId, row.id, card.id);
    // Written in the asker's language; read in the decider's. The asker is
    // answered below in their own words, off `card`.
    const shown = await localizeForRecipient(env, orgId, card, { payerGithubId: user.github_id });
    await announceCards(env, orgId, [shown]);
    await emitCard(env, orgId, card, "card.created");
    if (!rule && anyChannelConfigured(env) && recipient.login !== user.login) {
      await notifyCard(env, { card: shown, kind: "created", excludeLogin: user.login, orgId, payerGithubId: user.github_id }).catch((err) => console.error("channel notify failed", safe(err?.message)));
    }
    const decider = covering ? covering.to : recipient;
    const who = decider.login === user.login ? serverText(locale, "channel.you") : decider.name;
    // Why this person: the router's own one line, so the choice is visible
    // rather than taken on trust.
    // Not when the person named the decider themselves — "Reason: selected by
    // you" tells them what they just did.
    const picked = named.length === 1 || (resolved.kind === "dm" && named.length === 0);
    const why = picked ? "" : String(routed.routingReason || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const whyLine = why ? `\n${serverText(locale, "channel.why", { why })}` : "";
    const autoLine = rule ? `\n${serverText(locale, "channel.autoApproved", { name: recipient.name })}` : "";
    await say(serverText(locale, "channel.made", { who, title: card.title }) + whyLine + autoLine, card.id);
    await progress("done", { cardId: card.id });
    return card;
  } catch (err) {
    console.error("decide from message failed", safe(err?.message));
    await progress("failed");
    await say(serverText(locale, "channel.failed")).catch(() => {});
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
    const tz = url.searchParams.get("tz");
    if (tz) await rememberTimezone(env.DB, who.session.github_id, tz).catch(() => {});
    const members = await listMembers(env.DB, orgId, who.session.github_id);
    const access = await accessFor(env.DB, orgId, who.user.login);
    const prefs = {};
    for (const p of await prefsFor(env.DB, orgId, who.user.login)) {
      const v = viewOf(p.channel, who.user.login, members, access);
      if (v) prefs[v] = p.level;
    }
    const me = members.find((m) => m.mine);
    const refOf = (login) => members.find((m) => m.login === login)?.ref || null;
    return json({
      // Group DMs you are in: who else, by ref (a former member has none).
      groups: (await groupsOf(env.DB, orgId, who.user.login)).map((g) => ({
        view: g.key, refs: g.logins.filter((l) => l !== who.user.login).map(refOf).filter(Boolean),
      })),
      activity: await channelActivity(env.DB, orgId, who.user.login, members),
      prefs,
      // Your own away settings, with the delegate as a ref you can show.
      mine: me ? { status: me.status, awayUntil: me.awayUntil, delegateRef: members.find((m) => m.login === me.delegateLogin)?.ref || null } : null,
      // `loginHash` lets a browser tell which member a card it already holds
      // is from — cards carry logins — without being handed anyone's login.
      members: await Promise.all(members.map(async (m) => ({
        ref: m.ref, name: m.name, title: m.title || m.role, mine: m.mine,
        handle: m.handle || null, status: m.status || null, awayUntil: m.awayUntil || null, avatarUrl: m.avatarUrl || null,
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
    // Written now, sent later.
    if (body.sendAt) {
      const sched = await scheduleMessage(env.DB, { orgId, key: resolved.key, authorLogin: who.user.login, body: body.body, parentId, sendAt: body.sendAt });
      if (sched.error) return json({ message: sched.error }, 400);
      return json({ scheduled: { ...sched.scheduled, channel: view } }, 201);
    }
    // Files uploaded for this message come with it — yours, uploaded here.
    const fileIds = Array.isArray(body.files) ? body.files : [];
    const withFiles = fileIds.length > 0 && (await claimable(env.DB, { orgId, key: resolved.key, login: who.user.login, ids: fileIds })) > 0;
    const out = await postMessage(env.DB, { orgId, key: resolved.key, authorLogin: who.user.login, body: typeof body.body === "string" ? body.body : "", parentId, withFiles });
    if (out.error) return json({ message: out.error }, 400);
    if (withFiles) await attachFiles(env.DB, { orgId, key: resolved.key, login: who.user.login, messageId: out.row.id, ids: fileIds });
    const wantsDecision = body.decide === true || asksTheAI(out.row.body);
    const locale = who.user.locale || "en";
    after(async () => {
      await broadcastWithParent(env, orgId, resolved, out.row, members);
      await emitMessage(env, orgId, out.row);
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
    // Unsent: its files go with its words.
    if (request.method === "DELETE") await dropFiles(env, body.orgId, body.messageId);
    after(async () => {
      await broadcastWithParent(env, body.orgId, ctx.resolved, out.row, ctx.members);
      await emitMessage(env, body.orgId, out.row, { updated: true });
      // The journal said what this message said; its day is written again.
      await forgetJournalDay(env.DB, body.orgId, ctx.resolved.key, current.created_at);
    });
    const [message] = await present(env.DB, body.orgId, [out.row], ctx.who.user.login, ctx.view, ctx.members);
    return json({ message });
  }

  // A daily report, posted: the draft its owner read and, perhaps, rewrote,
  // said in the channel under their own name. Only its owner may, only once.
  if (path === "/channels/daily-report/post" && request.method === "POST") {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || typeof body.cardId !== "string") return json({ message: "Invalid JSON body." }, 400);
    const who = await caller(env, request, body.orgId);
    if (who.denied) return who.denied;
    const card = await getCard(env.DB, body.orgId, body.cardId);
    if (!card?.dailyReport || card.recipientUserID !== who.user.login) return json({ message: "No such draft." }, 404);
    if (card.dailyReport.status !== "draft") return json({ message: "This report has already been posted." }, 409);
    const text = (typeof body.text === "string" ? body.text : card.dailyReport.text || "").trim();
    if (!text) return json({ message: "The report is empty." }, 400);
    if (text.length > MAX_MESSAGE_CHARS) return json({ message: `A message is at most ${MAX_MESSAGE_CHARS} characters.` }, 400);
    const members = await listMembers(env.DB, body.orgId, who.session.github_id);
    const resolved = await resolveChannel(env.DB, body.orgId, who.user, card.dailyReport.channel, members);
    if (!resolved) return json({ message: "No such channel." }, 404);
    if (!(await claimDraft(env.DB, body.orgId, card.id))) return json({ message: "This report has already been posted." }, 409);
    const out = await postMessage(env.DB, { orgId: body.orgId, key: resolved.key, authorLogin: who.user.login, body: text });
    if (out.error) {
      await releaseDraft(env.DB, body.orgId, card.id);
      return json({ message: out.error }, 400);
    }
    const posted = postedCard(card, { text, messageId: out.row.id, login: who.user.login, at: out.row.created_at });
    await saveCard(env.DB, body.orgId, posted);
    await appendCardEvent(env.DB, body.orgId, {
      cardId: card.id, type: "decided", action: "acknowledge", actorUserId: who.user.login,
      note: `posted to #${resolved.slug || ""}`, snapshot: posted,
    });
    await markRead(env.DB, body.orgId, who.user.login, resolved.key, out.row.created_at);
    after(async () => {
      await broadcastWithParent(env, body.orgId, resolved, out.row, members);
      await emitMessage(env, body.orgId, out.row);
      await announceCards(env, body.orgId, [posted], { isNew: false });
    });
    const view = viewOf(resolved.key, who.user.login, members);
    const [message] = await present(env.DB, body.orgId, [out.row], who.user.login, view, members);
    return json({ card: posted, message }, 201);
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

  // A file or a picture, uploaded into a conversation you can read, for the
  // message you are about to send. The bytes are the body; the name and a
  // picture's size ride in the query.
  if (path === "/channels/files" && request.method === "POST") {
    const limited = await enforce(env, request, "files");
    if (limited) return limited;
    const orgId = url.searchParams.get("orgId");
    const ctx = await inChannel(env, request, { orgId, channel: url.searchParams.get("channel") });
    if (ctx.denied) return ctx.denied;
    return uploadFile(request, env, url, { orgId, resolved: ctx.resolved, login: ctx.who.user.login });
  }

  // A conversation with several people: one other is a DM, two to eight
  // others a group DM — the same people always find the same one.
  if (path === "/channels/groups" && request.method === "POST") {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const who = await caller(env, request, body.orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, body.orgId, who.session.github_id);
    const refs = [...new Set((Array.isArray(body.refs) ? body.refs : []).map(String))];
    const picked = members.filter((m) => refs.includes(m.ref) && m.login !== who.user.login);
    if (!refs.length || picked.length !== refs.length) return json({ message: "Somebody in that list is not in this workspace." }, 404);
    if (picked.length === 1) return json({ view: `dm:${picked[0].ref}` });
    if (picked.length + 1 > MAX_GROUP) return json({ message: `A group holds up to ${MAX_GROUP} people.` }, 400);
    const logins = [who.user.login, ...picked.map((m) => m.login)];
    const key = await groupFor(env.DB, { orgId: body.orgId, logins, createdBy: who.user.login });
    // Everyone in it has it in their list now, before a word is said.
    await announceTo(env, body.orgId, logins.map((login) => ({
      to: login,
      event: customEvent("channel_group", { view: key, refs: members.filter((m) => logins.includes(m.login) && m.login !== login).map((m) => m.ref) }),
    })));
    return json({ view: key, refs: picked.map((m) => m.ref) }, 201);
  }

  // A private channel's members: anyone inside may bring somebody in, or
  // take somebody out; anyone may leave.
  if (path === "/channels/members" && (request.method === "POST" || request.method === "DELETE")) {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    if (!(ctx.resolved.kind === "business" && ctx.resolved.private)) return json({ message: "Only a private channel has members to add or remove." }, 400);
    const orgId = body.orgId;
    const key = ctx.resolved.key;
    const me = ctx.who.user;
    const locale = await loadCopy(env, me.locale || "en", { orgId });
    const nameOf = (login) => ctx.members.find((m) => m.login === login)?.name || login;
    const listFor = async (login) => ({ to: login, event: customEvent("businesses", { businesses: await listBusinesses(env.DB, orgId, { viewer: login }) }) });
    const note = async (text) => {
      const out = await postMessage(env.DB, { orgId, key, authorLogin: null, body: text, kind: "ai" });
      if (out.row) await broadcast(env, orgId, { ...ctx.resolved, logins: await membersOf(env.DB, orgId, key) }, out.row, ctx.members);
    };
    if (request.method === "POST") {
      const refs = (Array.isArray(body.refs) ? body.refs : []).map(String);
      const inside = new Set(ctx.resolved.logins);
      const adding = ctx.members.filter((m) => refs.includes(m.ref) && !inside.has(m.login));
      if (!adding.length) return json({ added: 0 });
      await addMembers(env.DB, { orgId, key, logins: adding.map((m) => m.login), addedBy: me.login });
      await announceTo(env, orgId, await Promise.all(adding.map((m) => listFor(m.login))));
      await note(serverText(locale, "channel.added", { who: nameOf(me.login), names: adding.map((m) => m.name).join(", ") }));
      return json({ added: adding.length });
    }
    const target = body.ref ? ctx.members.find((m) => m.ref === String(body.ref)) : ctx.members.find((m) => m.login === me.login);
    if (!target || !ctx.resolved.logins.includes(target.login)) return json({ message: "They are not in this channel." }, 404);
    await removeMember(env.DB, { orgId, key, login: target.login });
    await announceTo(env, orgId, [await listFor(target.login)]);
    await note(target.login === me.login
      ? serverText(locale, "channel.left", { who: nameOf(me.login) })
      : serverText(locale, "channel.removed", { who: nameOf(me.login), name: target.name }));
    return json({ removed: target.ref });
  }

  // Where a message is, for a link to it: the conversation as this reader
  // names it, and the thread it is in. A link carries only the message's id,
  // so anybody may hold one; only somebody who can read the conversation
  // learns where it goes.
  if (path === "/channels/locate" && request.method === "GET") {
    const orgId = url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const row = await getMessage(env.DB, orgId, String(url.searchParams.get("messageId") || "").slice(0, 80));
    const members = row ? await listMembers(env.DB, orgId, who.session.github_id) : [];
    const view = row && !row.deleted_at ? viewOf(row.channel, who.user.login, members, await accessFor(env.DB, orgId, who.user.login)) : null;
    if (!view) return json({ message: "No such message." }, 404);
    return json({ view, id: row.id, parentId: row.parent_id || null });
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
  // Your status, and being away with somebody deciding for you.
  if (path === "/channels/status" && request.method === "PUT") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const who = await caller(env, request, body.orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, body.orgId, who.session.github_id);
    let delegateLogin = null;
    if (body.awayUntil && body.delegateRef) {
      const d = members.find((m) => m.ref === body.delegateRef);
      if (!d || d.login === who.user.login) return json({ message: "Pick somebody else in this workspace." }, 400);
      delegateLogin = d.login;
    }
    const out = await setStatus(env.DB, { orgId: body.orgId, githubId: who.session.github_id, emoji: body.emoji, text: body.text, until: body.until, awayUntil: body.awayUntil, delegateLogin });
    if (out.error) return json({ message: out.error }, 400);
    return json({ ok: true });
  }

  // A channel, described: what it is for, who is in it, what was shared
  // in it, what runs into it — the panel behind its header.
  if (path === "/channels/details" && request.method === "GET") {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const orgId = url.searchParams.get("orgId");
    const ctx = await inChannel(env, request, { orgId, channel: url.searchParams.get("channel") });
    if (ctx.denied) return ctx.denied;
    const locale = await loadCopy(env, ctx.who.user.locale || "en", { orgId });
    const details = await channelDetails(env.DB, orgId, { resolved: ctx.resolved, viewer: ctx.who.user, members: ctx.members, locale });
    return json({ ...details, channel: { ...details.channel, view: ctx.view } });
  }

  // What a channel is for, in a sentence anyone in it may write.
  if (path === "/channels/description" && request.method === "PUT") {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    const out = await setDescription(env.DB, body.orgId, ctx.resolved.key, body.description);
    if (out.error) return json({ message: out.error }, out.status || 400);
    const described = customEvent("channel_described", { channel: ctx.resolved.key, description: out.description });
    after(() => (ctx.resolved.private
      ? announceTo(env, body.orgId, ctx.resolved.logins.map((login) => ({ to: login, event: described })))
      : announceEvents(env, body.orgId, [described])));
    return json(out);
  }

  // The channel's journal: a few lines a day, each citing its messages.
  if (path === "/channels/journal" && request.method === "GET") {
    const limited = await enforce(env, request, "journal");
    if (limited) return limited;
    const orgId = url.searchParams.get("orgId");
    const ctx = await inChannel(env, request, { orgId, channel: url.searchParams.get("channel") });
    if (ctx.denied) return ctx.denied;
    const tzParam = url.searchParams.get("tz");
    const tz = validZone(tzParam) ? tzParam : "UTC";
    const before = url.searchParams.get("before");
    if (before && !validDay(before)) return json({ message: "before is a date, YYYY-MM-DD." }, 400);
    const locale = await loadCopy(env, ctx.who.user.locale || "en", { orgId });
    const provider = await providerFor(env, orgId);
    const allowance = provider ? await allowanceFor(env, orgId, { githubId: String(ctx.who.session.github_id) }) : null;
    const name = ctx.resolved.kind === "dm" ? (ctx.resolved.other?.name || "")
      : ctx.resolved.kind === "group" ? ctx.resolved.others.map((m) => m.name).join(", ")
      : `#${ctx.resolved.slug}`;
    try {
      const page = await channelJournal(env, orgId, {
        resolved: ctx.resolved, members: ctx.members, tz, before, locale, provider, allowance, channelName: name,
      });
      const row = await channelRow(env.DB, orgId, ctx.resolved.key);
      return json({ ...page, channel: ctx.view, tz, description: row?.description || null, describable: ctx.resolved.kind === "business" });
    } finally {
      await settleUsage(env.DB, provider, { orgId, githubId: ctx.who.session.github_id });
    }
  }

  // A Jam's recording, uploaded by the browser that recorded it when it
  // ended: notes are written from it and said in the channel; a full
  // recording is kept for the channel to play back.
  if (path === "/channels/jam/recording" && request.method === "POST") {
    const limited = await enforce(env, request, "jam/recording");
    if (limited) return limited;
    const orgId = url.searchParams.get("orgId");
    const ctx = await inChannel(env, request, { orgId, channel: url.searchParams.get("channel") });
    if (ctx.denied) return ctx.denied;
    const contentType = recordingType(request.headers.get("content-type"));
    if (!contentType) return json({ message: "That is not a recording." }, 415);
    if (Number(request.headers.get("content-length") || 0) > MAX_RECORDING_BYTES) return json({ message: "That recording is too long." }, 413);
    if (!request.body) return json({ message: "No recording in the request." }, 400);
    const bytes = await readCapped(request.body, MAX_RECORDING_BYTES);
    if (!bytes) return json({ message: "That recording is too long." }, 413);
    if (bytes.byteLength < 1024) return json({ message: "That recording is empty." }, 400);
    const mode = url.searchParams.get("mode") === "full" ? "full" : "notes";
    const startedAt = url.searchParams.get("startedAt");
    const endedAt = url.searchParams.get("endedAt") || new Date().toISOString();
    const minutes = Number.isFinite(Date.parse(startedAt)) ? Math.min(minutesBetween(startedAt, endedAt), 600) : 1;
    const refs = String(url.searchParams.get("people") || "").split(",").map((r) => r.trim()).filter(Boolean).slice(0, 20);
    const names = refs.map((r) => ctx.members.find((m) => m.ref === r)?.name).filter(Boolean);
    if (!names.length) names.push(ctx.who.user.name || ctx.who.user.login);
    let recordingUrl = null;
    let id = null;
    if (mode === "full") {
      id = crypto.randomUUID();
      await env.MEDIA.put(`jam/${id}`, bytes, { httpMetadata: { contentType } });
      recordingUrl = `${url.origin}/channels/jam/audio/${id}`;
    }
    const locale = await loadCopy(env, ctx.who.user.locale || "en", { orgId });
    after(async () => {
      const provider = await providerFor(env, orgId);
      const allowance = provider ? await allowanceFor(env, orgId, { githubId: String(ctx.who.session.github_id) }) : null;
      let notes = null;
      try {
        if (provider && (!allowance || allowance.allowed)) {
          const transcript = await transcribe(env, provider, bytes, contentType, { locale });
          if (transcript) {
            // Transcription is billed by the minute, not by the token.
            provider.usage?.push({ purpose: "jam_transcript", provider: "OpenAI", model: env.JAM_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe", input: 0, output: 0, usd: minutes * 0.003 });
            notes = await jamNotes(provider, transcript, { locale, allowance });
          }
        }
      } finally {
        await settleUsage(env.DB, provider, { orgId, githubId: ctx.who.session.github_id });
      }
      if (!notes && !recordingUrl) return;
      const out = await postMessage(env.DB, {
        orgId, key: ctx.resolved.key, authorLogin: null, kind: "ai",
        body: recordingMessage(locale, { minutes, people: names.join(", "), notes, url: recordingUrl }),
      });
      if (out.row) await broadcastWithParent(env, orgId, ctx.resolved, out.row, ctx.members);
    });
    return json({ id, url: recordingUrl, notes: true }, 202);
  }

  const audio = path.match(/^\/channels\/jam\/audio\/([^/]+)$/);
  if (audio && request.method === "GET") {
    return serveRecording(env, audio[1]);
  }

  // How loudly one conversation may call for you.
  if (path === "/channels/prefs" && request.method === "PUT") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    const out = await setChannelPref(env.DB, { orgId: body.orgId, login: ctx.who.user.login, key: ctx.resolved.key, level: body.level });
    if (out.error) return json({ message: out.error }, 400);
    return json({ ok: true, level: body.level });
  }

  // A teammate's profile.
  if (path === "/channels/member" && request.method === "GET") {
    const orgId = url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, orgId, who.session.github_id);
    const m = members.find((x) => x.ref === url.searchParams.get("ref"));
    if (!m) return json({ message: "Nobody by that name here." }, 404);
    return json({ member: { ...(await memberProfile(env.DB, orgId, m)), mine: m.mine } });
  }

  // Scheduled messages: yours, in one conversation or all of them.
  if (path === "/channels/scheduled" && (request.method === "GET" || request.method === "DELETE")) {
    if (request.method === "GET") {
      const orgId = url.searchParams.get("orgId");
      const who = await caller(env, request, orgId);
      if (who.denied) return who.denied;
      const members = await listMembers(env.DB, orgId, who.session.github_id);
      const rows = await listScheduled(env.DB, orgId, who.user.login);
      const access = await accessFor(env.DB, orgId, who.user.login);
      return json({ scheduled: rows.map((r) => ({ id: r.id, body: r.body, sendAt: r.sendAt, parentId: r.parentId, channel: viewOf(r.key, who.user.login, members, access) })).filter((r) => r.channel) });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body.id !== "string") return json({ message: "Invalid JSON body." }, 400);
    const who = await caller(env, request, body.orgId);
    if (who.denied) return who.denied;
    return (await cancelScheduled(env.DB, body.orgId, who.user.login, body.id)) ? json({ ok: true }) : json({ message: "Nothing to cancel." }, 404);
  }

  // Later: saved messages, and a reminder that brings one back as a card.
  if (path === "/channels/later") {
    if (request.method === "GET") {
      const orgId = url.searchParams.get("orgId");
      const who = await caller(env, request, orgId);
      if (who.denied) return who.denied;
      const members = await listMembers(env.DB, orgId, who.session.github_id);
      const rows = await listSaved(env.DB, orgId, who.user.login);
      const access = await accessFor(env.DB, orgId, who.user.login);
      const items = [];
      for (const r of rows) {
        const view = viewOf(r.channel, who.user.login, members, access);
        if (!view) continue;
        const [message] = await present(env.DB, orgId, [r], who.user.login, view, members);
        items.push({ id: r.saved_id, remindAt: r.remind_at, remindedAt: r.reminded_at, savedAt: r.saved_at, message });
      }
      return json({ items });
    }
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    if (request.method === "DELETE") {
      const who = await caller(env, request, body.orgId);
      if (who.denied) return who.denied;
      return (await finishSaved(env.DB, body.orgId, who.user.login, String(body.id || ""))) ? json({ ok: true }) : json({ message: "Nothing saved by that id." }, 404);
    }
    if (request.method === "POST") {
      const ctx = await inChannel(env, request, body);
      if (ctx.denied) return ctx.denied;
      const out = await saveForLater(env.DB, { orgId: body.orgId, login: ctx.who.user.login, messageId: String(body.messageId || ""), key: ctx.resolved.key, remindAt: body.remindAt || null });
      if (out.error) return json({ message: out.error }, 400);
      return json({ id: out.id }, 201);
    }
  }

  // Clips: messages picked from anywhere you can read, made one decision.
  if (path === "/channels/clip" && request.method === "POST") {
    const limited = await enforce(env, request, "ai/route");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || !Array.isArray(body.items)) return json({ message: "Invalid JSON body." }, 400);
    if (!body.items.length || body.items.length > 30) return json({ message: "Clip between 1 and 30 messages." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    const lines = [];
    const picked = [];
    for (const item of body.items) {
      const from = await resolveChannel(env.DB, body.orgId, ctx.who.user, item?.channel, ctx.members);
      const row = from && typeof item.messageId === "string" ? await getMessage(env.DB, body.orgId, item.messageId) : null;
      // Only what this person can read, and only what still exists.
      if (!row || row.channel !== from.key || row.deleted_at) return json({ message: "One of those messages is not yours to use." }, 403);
      picked.push({ row, where: from.kind === "business" ? `#${from.slug}` : "a direct conversation" });
    }
    picked.sort((a, b) => a.row.created_at.localeCompare(b.row.created_at));
    for (const { row, where } of picked) {
      const who = row.kind === "ai" ? "AI" : (row.author_name || "someone");
      lines.push(`${String(row.created_at).slice(5, 16).replace("T", " ")} ${where} ${who}: ${String(row.body).replace(/\s+/g, " ").slice(0, 500)}`);
    }
    const asker = await loadCopy(env, ctx.who.user.locale || "en", { orgId: body.orgId });
    const instruction = String(body.instruction || "").trim().slice(0, 1000)
      || serverText(asker, "channel.fromMessages");
    // The request itself is said where the person is, so the card has a
    // message to hang off and the conversation shows what happened.
    const anchor = await postMessage(env.DB, { orgId: body.orgId, key: ctx.resolved.key, authorLogin: ctx.who.user.login, body: `📎 ${instruction} (${picked.length})` });
    if (anchor.error) return json({ message: anchor.error }, 400);
    const locale = ctx.who.user.locale || "en";
    after(async () => {
      await broadcastWithParent(env, body.orgId, ctx.resolved, anchor.row, ctx.members);
      await decideFromMessage(env, { orgId: body.orgId, session: ctx.who.session, user: ctx.who.user, resolved: ctx.resolved, row: { ...anchor.row, body: instruction }, members: ctx.members, route, locale, clipped: lines });
    });
    const [message] = await present(env.DB, body.orgId, [anchor.row], ctx.who.user.login, ctx.view, ctx.members);
    return json({ message, deciding: true }, 202);
  }

  // Auto-approve rules: your standing yeses.
  if (path === "/channels/auto-rules") {
    const orgId = request.method === "GET" ? url.searchParams.get("orgId") : null;
    const body = request.method === "GET" ? { orgId } : await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const who = await caller(env, request, body.orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, body.orgId, who.session.github_id);
    const shape = (r) => ({ id: r.id, senderName: members.find((m) => m.login === r.sender_login)?.name || r.sender_name || null, cardType: r.card_type, business: r.business, createdAt: r.created_at });
    if (request.method === "GET") return json({ rules: (await listAutoRules(env.DB, body.orgId, who.user.login)).map(shape) });
    if (request.method === "DELETE") {
      return (await removeAutoRule(env.DB, body.orgId, who.user.login, String(body.id || ""))) ? json({ ok: true }) : json({ message: "No such rule." }, 404);
    }
    if (request.method === "POST") {
      // Made from a card you decided: its sender, type and business. A card
      // id rather than a login, so a browser never has to hold one.
      const { getCard } = await import("./db.js");
      const card = typeof body.cardId === "string" ? await getCard(env.DB, body.orgId, body.cardId) : null;
      if (!card || card.recipientUserID !== who.user.login) return json({ message: "That is not a decision of yours." }, 404);
      const out = await addAutoRule(env.DB, { orgId: body.orgId, recipientLogin: who.user.login, senderLogin: card.senderUserID, cardType: card.type || "approval", business: body.anyBusiness ? null : (card.business || null) });
      if (out.error) return json({ message: out.error }, 400);
      return json({ id: out.id }, 201);
    }
  }
  return null;
}


/// For the cron: tell a conversation, known only by its stored key, about a
/// message that just went into it.
export async function broadcastStored(env, orgId, key, row) {
  const members = await listMembers(env.DB, orgId, null);
  let resolved;
  const logins = await audienceOf(env.DB, orgId, key);
  if (key.startsWith("b:")) resolved = logins ? { key, kind: "business", slug: key.slice(2), private: true, logins } : { key, kind: "business", slug: key.slice(2) };
  else if (key.startsWith("dm:")) resolved = { key, kind: "dm", logins };
  else if (key.startsWith("g:")) resolved = { key, kind: "group", logins };
  else return;
  await broadcastWithParent(env, orgId, resolved, row, members);
  await emitMessage(env, orgId, row);
}
