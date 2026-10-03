import { checkOutgoing } from "./dlp.js";
import { attachedTexts } from "./dlpFiles.js";
import { linksIn, readLinks, linksBlock } from "./links.js";
import { agentTools } from "./agentTools.js";
import { translateMessages } from "./translate.js";
import { getSession, isMember, getUserByGithubId, getUserByLogin, saveCard, getCard, listBusinesses } from "./db.js";
import { claimDraft, releaseDraft, postedCard, refineDailyReport, saveDraftText, discardDraft, dailyChannelFor } from "./dailyReport.js";
import { providerFor, readerEnvFor } from "./orgAI.js";
import { groupsIn, toClientGroup, saveGroup, deleteGroup, getSidebar, saveSidebar, foldSection } from "./people-groups.js";
import { allowanceFor } from "./gate.js";
import { enforce } from "./ratelimit.js";
import { listMembers } from "./team.js";
import { allowed } from "./permissions.js";
import { resolveMentions } from "./threads.js";
import { teammateForAgent, startTeammateRun, loadTeammate, readRun, settleRun, openRuns, canSignIn } from "./teammates.js";
import { answerAsProxies, proxyTeammateAnswer, getProxy, saveProxy } from "./proxy.js";
import { appendCardEvent } from "./events.js";
import { announceCards, announceEvents, announceTo } from "./announce.js";
import { localizeForRecipient } from "./localize.js";
import { loadCopy } from "./copy.js";
import { serverText } from "./serverCopy.js";
import { notifyCard, anyChannelConfigured } from "./notify.js";
import { custom as customEvent } from "./agui/events.js";
import {
  resolveChannel, listMessages, postMessage, getMessage, linkCard, transcriptUpTo, channelActivity, clientIdOk,
  viewOf, asksTheAI, asksForDecision, withoutAI, MAX_MESSAGE_CHARS,
  present, listThread, listPins, editMessage, deleteMessage, toggleReaction, setPinned, setPreviewsHidden,
  markRead, markUnreadFrom, markActivitySeen, readThreadsSeenInActivity, readsFor, activityFeed, searchMessages, threadsFor,
} from "./channels.js";
import { safe } from "./log.js";
import { emitMessage, emitCard } from "./webhooks.js";
import { sha256Hex } from "./auth.js";
import { applyAutoRule, listAutoRules, addAutoRule, removeAutoRule } from "./autorules.js";
import { setStatus, rememberTimezone, redirectIfAway, setChannelPref, prefsFor, memberProfile } from "./people.js";
import { scheduleMessage, listScheduled, cancelScheduled, saveForLater, listSaved, finishSaved, listSent } from "./later.js";
import { channelDetails, setDescription, channelRow } from "./channelDetails.js";
import { channelJournal, forgetJournalDay, validDay, validZone } from "./journal.js";
import { settleUsage } from "./ledger.js";
import { readCapped } from "./media.js";
import { uploadFile, attachFiles, claimable, dropFiles } from "./files.js";
import { queueMessagePushes, clearDelivered, clearDeliveredMessages } from "./pushes.js";
import { audit, person } from "./audit.js";
import { getCanvas, toClientCanvas, listRevisions, getRevision, saveCanvas, draftCanvas } from "./canvas.js";
import { listBookmarks, toClientBookmark, addBookmark, editBookmark, removeBookmark } from "./bookmarks.js";
import {
  listAgents, saveAgent, deleteAgent, toClientAgent, agentsHere, channelAgents, agentChannels, agentTalkFilter, addChannelAgent, removeChannelAgent, presetsFor, agentsCalled, requestFor, askAgent, contextFor, playbookFor, setAgentAvatar, MAX_CALLED,
} from "./customAgents.js";
import { readImage } from "./userAvatar.js";
import { connectedSources, searchNotion, searchGithubIssues, formatSourcesForModel } from "./context.js";
import { searchTermsFor } from "./ask.js";
import { searchDecisions } from "./insights.js";
import { accessFor, audienceOf, groupFor, groupsOf, addMembers, removeMember, membersOf, MAX_GROUP, isPrivate, isGuest } from "./access.js";
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

export async function caller(env, request, orgId) {
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return { denied: json({ message: "Please sign in." }, 401) };
  if (!orgId || typeof orgId !== "string") return { denied: json({ message: "orgId is required" }, 400) };
  if (!(await isMember(env.DB, orgId, session.github_id))) return { denied: json({ message: "not a member of this org" }, 403) };
  { const { policyDenial } = await import("./policy.js"); const held = await policyDenial(env, session, orgId); if (held) return { denied: json(held.body, held.status) }; }
  const user = await getUserByGithubId(env.DB, session.github_id);
  if (!user?.login) return { denied: json({ message: "Please sign in." }, 401) };
  return { session, user: { ...user, github_id: session.github_id } };
}

/// The caller, the channel they named, and how they see it — or why not.
export async function inChannel(env, request, { orgId, channel }) {
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
  if (resolved.kind === "business" && !resolved.logins) {
    const [message] = await present(env.DB, orgId, [fresh], null, resolved.key, members);
    await announceEvents(env, orgId, [customEvent("channel_message", { message })]);
    return;
  }
  await announceTo(env, orgId, await Promise.all(resolved.logins.map(async (login) => {
    const [message] = await present(env.DB, orgId, [fresh], login, viewOf(resolved.key, login, members), members);
    return { to: login, event: customEvent("channel_message", { message }) };
  })));
}

/// Read on one device, read on all of them: this person's other tabs and
/// phones hear it at once, and a phone clears the notifications it still
/// shows for it.
async function readEverywhere(env, orgId, login, { view, key, thread, lastReadAt, items, threads, unread }) {
  const value = items ? { items, ...(threads?.length ? { threads } : {}) } : { view, thread: thread || null, lastReadAt, ...(unread ? { unread: true } : {}) };
  await announceTo(env, orgId, [{ to: login, event: customEvent("reads_changed", value) }]);
  if (!unread && key) await clearDelivered(env, orgId, login, { key, view, thread, lastReadAt }).catch((err) => console.error("clear push failed", safe(err?.message)));
  // Items looked at in Activity: their own notifications come down too.
  if (items?.length) {
    const ids = items.filter((k) => k.startsWith("m:")).map((k) => k.slice(2));
    await clearDeliveredMessages(env, orgId, login, ids).catch((err) => console.error("clear push failed", safe(err?.message)));
  }
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
      if (resolved.kind === "business" && !resolved.logins) await announceEvents(env, orgId, [payload(resolved.key)]);
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
      // Talk with the agents is not part of it: calling @hayao, and what
      // it answered, is research, not what the team is deciding.
      const skip = await agentTalkFilter(env.DB, orgId);
      const transcript = await transcriptUpTo(env.DB, orgId, resolved.key, row.created_at, { threadId: row.parent_id || null, throughId: row.id, skip: (r) => r.id !== row.id && r.id !== row.parent_id && skip(r) });
      context = `Conversation in ${where} leading to this request (oldest first):\n${transcript.join("\n")}`;
    }
    if (context.length > 3800) {
      const root = row.parent_id && !clipped ? context.split("\n").slice(0, 2).join("\n") + "\n" : "";
      context = `${root}…${context.slice(context.length - (3799 - root.length))}`;
    }

    // Whoever the message names decides; in a direct conversation with
    // nobody named, the other person does.
    const named = resolveMentions(instruction, members, { here: false }).filter((m) => m.login !== user.login);
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

/// The team's AI, asked something in a conversation: it answers in the
/// thread under the question, as the AI — reading the conversation, the
/// playbook and any link — and makes no card. Never throws; what goes
/// wrong is said in the thread.
const TEAM_AI = {
  id: "ai", handle: "AI", name: "AI", emoji: null,
  instructions: `You are the team's own AI assistant in its chat. Answer what you are asked: explain, summarise the conversation, draft a reply or a document, compare options, give a recommendation with its reasons. You do not create decision cards here; if the person clearly wants someone to approve or decide something, end with one short line saying they can send it as a decision.`,
};
export async function answerAsAI(env, { orgId, session, user, resolved, row, members, locale }) {
  locale = await loadCopy(env, locale || "en", { orgId });
  const parentId = row.parent_id || row.id;
  const face = { id: "ai", handle: "AI", name: "AI", emoji: "✨" };
  const progress = async (step) => {
    try {
      const payload = (view) => customEvent("channel_ai_progress", { channel: view, parentId, messageId: row.id, step, agent: face });
      if (resolved.kind === "business" && !resolved.logins) await announceEvents(env, orgId, [payload(resolved.key)]);
      else await announceTo(env, orgId, resolved.logins.map((login) => ({ to: login, event: payload(viewOf(resolved.key, login, members)) })));
    } catch (err) {
      console.error("ai progress failed", safe(err?.message));
    }
  };
  const say = async (body) => {
    const out = await postMessage(env.DB, { orgId, key: resolved.key, authorLogin: null, body, kind: "ai", parentId });
    if (out.row) {
      await broadcastWithParent(env, orgId, resolved, out.row, members);
      await emitMessage(env, orgId, out.row);
    }
  };
  await progress("agent");
  try {
    const provider = await providerFor(env, orgId);
    const allowance = provider ? await allowanceFor(env, orgId, { githubId: String(session.github_id) }) : null;
    if (!provider) { await say(serverText(locale, "agent.noModel")); return false; }
    if (!allowance.allowed) { await say(serverText(locale, "agent.quota")); return false; }
    const [transcript, playbook] = await Promise.all([contextFor(env.DB, orgId, resolved.key, row), row.parent_id ? [] : playbookFor(env.DB, orgId, row.body)]);
    let links = "";
    try {
      const urls = linksIn(row.body).length ? linksIn(row.body) : linksIn(transcript.slice(-6).join("\n"));
      if (urls.length) links = linksBlock(await readLinks(urls, { language: locale, env: await readerEnvFor(env, orgId) }));
    } catch (err) {
      console.error("ai links failed", safe(err?.message));
    }
    const where = resolved.kind === "business" ? `#${resolved.slug}` : "a direct conversation";
    const result = await askAgent({
      provider, agent: TEAM_AI, request: withoutAI(row.body), transcript, playbook, where, links, env,
      askedBy: user.name || "a teammate", readerLanguage: locale,
      deadline: Date.now() + 25000, onRound: () => progress("agent"),
    });
    if (result.called && allowance.metered) await allowance.consume();
    await say(result.answer || serverText(locale, result.called ? "agent.failedEmpty" : "agent.failedService"));
    await settleUsage(env.DB, provider, { orgId, githubId: session.github_id });
    return Boolean(result.answer);
  } catch (err) {
    console.error("ai answer failed", safe(err?.message));
    await say(serverText(locale, "agent.failedError")).catch(() => {});
    return false;
  } finally {
    await progress("done");
  }
}

/// `route(body)` is `/ai/route`, called in-process with this request's
/// session. `after(work)` runs work past the response.
/// The team's agents a message names, each answering in the thread under
/// it as itself. Only a person's message calls one — an agent's answer
/// naming another does not, so two agents never talk each other in
/// circles. Never throws; what goes wrong is said in the thread.
/// The agents a person can call, for the @ menu and for colouring a
/// mention: the team's, their own, and any added to a channel they can
/// read — with those channels, as they see them.
async function callableAgents(db, orgId, login, members) {
  const face = (a) => ({ id: a.id, handle: a.handle, name: a.name, emoji: a.emoji, avatarUrl: a.avatarUrl || null, description: a.description, scope: a.scope });
  const own = await listAgents(db, orgId, login);
  const placed = await agentChannels(db, orgId);
  const access = placed.length ? await accessFor(db, orgId, login) : null;
  const channelsOf = new Map();
  for (const { agent, keys } of placed) {
    const views = keys.map((k) => viewOf(k, login, members, access)).filter(Boolean);
    if (views.length) channelsOf.set(agent.id, { agent, views });
  }
  const out = own.map((a) => ({ ...face(a), channels: channelsOf.get(a.id)?.views || [] }));
  const handles = new Set(own.map((a) => a.handle));
  for (const { agent, views } of channelsOf.values()) {
    if (out.some((a) => a.id === agent.id) || handles.has(agent.handle)) continue;
    // Callable only where it was added.
    out.push({ ...face(agent), channels: views, placed: true });
  }
  return out;
}

export async function answerAsAgents(env, { orgId, session, user, resolved, row, members, locale }) {
  let agents;
  try {
    // Their own agents, and the ones added to this channel.
    agents = agentsCalled(row.body, await agentsHere(env.DB, orgId, user.login, resolved.key));
    // In a conversation with an agent, everything said is said to it: it
    // answers without being named, in the conversation, not a thread.
    if (resolved.kind === "agent" && !agents.some((a) => a.id === resolved.agent.id)) {
      const own = (await listAgents(env.DB, orgId, user.login)).find((a) => a.id === resolved.agent.id);
      if (own) agents = [own, ...agents].slice(0, MAX_CALLED);
    }
  } catch (err) {
    console.error("agents lookup failed", safe(err?.message));
    return 0;
  }
  if (!agents.length) return 0;
  // Research takes longer than the half minute a request may keep working
  // after it answers: in production the agents answer from a Durable
  // Object's alarm, which may run for minutes (agentRunner.js).
  if (env.AGENT_RUNNER && env.AGENT_INLINE !== "1" && session?.token) {
    try {
      const stub = env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(orgId));
      const res = await stub.fetch("https://agents/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, token: session.token, rowId: row.id, locale: locale || "en" }),
      });
      if (res.ok) return 0;
    } catch (err) {
      console.error("agent enqueue failed", safe(err?.message));
    }
  }
  return runAgents(env, { orgId, session, user, resolved, row, members, locale, agents });
}

/// Whether every agent called is one the person wrote themselves. Agents
/// come from listAgents as `ownerLogin`; this read `owner_login`, which they
/// never carry, so no agent was ever anyone's own and an app's writing
/// tools were never offered — not even to your own agent.
export function allOwnAgents(agents, login) {
  return Boolean(login) && agents.length > 0 && agents.every((a) => (a.ownerLogin ?? a.owner_login) === login);
}

/// The agents' answers, side by side: each reads the conversation,
/// researches with its tools, and answers as itself when it is ready.
export async function runAgents(env, { orgId, session, user, resolved, row, members, locale, agents }) {
  locale = await loadCopy(env, locale || "en", { orgId });
  const parentId = row.parent_id || (resolved.kind === "agent" ? null : row.id);
  const face = (a) => ({ id: a.id, handle: a.handle, name: a.name, emoji: a.emoji || null, avatarUrl: a.avatarUrl || a.avatar_url || null });
  const progress = async (agent, step) => {
    try {
      const payload = (view) => customEvent("channel_ai_progress", { channel: view, parentId, messageId: row.id, step, agent: face(agent) });
      if (resolved.kind === "business" && !resolved.logins) await announceEvents(env, orgId, [payload(resolved.key)]);
      else await announceTo(env, orgId, resolved.logins.map((login) => ({ to: login, event: payload(viewOf(resolved.key, login, members)) })));
    } catch (err) {
      console.error("agent progress failed", safe(err?.message));
    }
  };
  const provider = await providerFor(env, orgId);
  const allowance = provider ? await allowanceFor(env, orgId, { githubId: String(session.github_id) }) : null;
  const [transcript, playbook] = provider && allowance?.allowed
    ? await Promise.all([contextFor(env.DB, orgId, resolved.key, row), row.parent_id ? [] : playbookFor(env.DB, orgId, row.body)])
    : [[], []];
  // Research, in a conversation with the agent only: past decisions and
  // what this person's connected tools hold are theirs to read, and would
  // be somebody else's to read if the answer went into a shared channel.
  let research = "";
  if (!row.parent_id && resolved.kind === "agent" && provider && allowance?.allowed) {
    try {
      const terms = searchTermsFor(row.body, null);
      const available = await connectedSources(env, session, orgId);
      const [decisions, notion, github] = await Promise.all([
        terms ? searchDecisions(env.DB, orgId, terms).catch(() => []) : [],
        available.notion && terms ? searchNotion(env, session.github_id, terms).catch(() => []) : [],
        available.github && terms ? searchGithubIssues(session, orgId, terms, env).catch(() => []) : [],
      ]);
      const lines = decisions.slice(0, 8).map((d) => `- ${d.decidedAt ? String(d.decidedAt).slice(0, 10) : "pending"}${d.recipient ? ` ${d.recipient}` : ""} ${d.status || ""}: ${String(d.title || "").slice(0, 140)}`);
      const tools = [...notion, ...github].slice(0, 8);
      if (lines.length) research += `Past decisions that match:\n${lines.join("\n")}\n`;
      if (tools.length) research += `From the person's connected tools:\n${formatSourcesForModel(tools)}\n`;
    } catch (err) {
      console.error("agent research failed", safe(err?.message));
    }
  }
  // Links in the message, or else in what was said just before it: a
  // video, a post or a page the agent is asked about is opened and read.
  let links = "";
  if (provider && allowance?.allowed) {
    try {
      const urls = linksIn(row.body).length ? linksIn(row.body) : linksIn(transcript.slice(-6).join("\n"));
      if (urls.length) links = linksBlock(await readLinks(urls, { language: locale, env: await readerEnvFor(env, orgId) }));
    } catch (err) {
      console.error("agent links failed", safe(err?.message));
    }
  }
  const where = resolved.kind === "business" ? `#${resolved.slug}` : resolved.kind === "agent" ? "a direct conversation with you" : "a direct conversation";
  // What it may call while it researches: open any page; in its own
  // conversation, the team's decisions and this person's tools too.
  const tools = provider && allowance?.allowed
    ? await agentTools(env, {
      orgId, session, language: locale, personal: resolved.kind === "agent" && !row.parent_id,
      // An app that may write does so only for agents the person wrote
      // themselves: a teammate's agent's instructions never steer it.
      ownAgentsOnly: allOwnAgents(agents, user.login),
    }).catch(() => ({}))
    : {};
  let answered = 0;
  // A metered day is one budget for the whole message. `remaining` was read
  // once above; spending it here stops five parallel answers from running
  // past the last call the person has left. Teammates bill their own
  // service, so they do not take a slot.
  let modelLeft = !allowance?.metered ? Infinity : Math.max(0, allowance.remaining ?? 0);
  const spend = agents.map((agent) => {
    if (agent.provider) return "teammate";
    if (!allowance?.metered) return allowance?.allowed ? "model" : "quota";
    if (modelLeft <= 0) return "quota";
    modelLeft -= 1;
    return "model";
  });
  // Every agent called works at once, each answering as soon as it is done:
  // five agents take as long as the slowest, not the sum of all five.
  const answerOne = async (agent, index) => {
    // An AI teammate works through its own service, not the workspace's
    // model: it starts, says so, and answers when it is done.
    if (agent.provider) {
      await progress(agent, "agent");
      const t = await teammateForAgent(env.DB, orgId, agent).catch(() => null);
      await runTeammate(env, { orgId, user, resolved, row, members, locale, agent, t, deadline: Date.now() + (env.TEAMMATE_WATCH_MS !== undefined ? Number(env.TEAMMATE_WATCH_MS) : env.AGENT_INLINE === "1" || !env.AGENT_RUNNER ? 20000 : 240000) })
        .catch((err) => console.error("teammate failed", safe(err?.message)));
      await progress(agent, "done");
      return;
    }
    await progress(agent, "agent");
    let text;
    try {
      if (!provider) text = serverText(locale, "agent.noModel");
      else if (spend[index] !== "model") text = serverText(locale, "agent.quota");
      else {
        const result = await askAgent({
          provider, agent, request: requestFor(row.body, agent), transcript, playbook, where, research, links, tools, env,
          askedBy: user.name || "a teammate", readerLanguage: locale,
          deadline: Date.now() + (env.AGENT_INLINE === "1" || !env.AGENT_RUNNER ? 25000 : 240000),
          onRound: () => progress(agent, "agent"),
        });
        if (result.called && allowance.metered) await allowance.consume();
        // No answer: say why, so nobody waits on silence — the AI service
        // turned it down (no call was paid for), or it ran out of time.
        text = result.answer || serverText(locale, result.called ? "agent.failedEmpty" : "agent.failedService");
        if (result.answer) answered += 1;
      }
      const out = await postMessage(env.DB, { orgId, key: resolved.key, authorLogin: `agent:${agent.id}`, body: text, kind: "agent", parentId });
      if (out.row) {
        await broadcastWithParent(env, orgId, resolved, out.row, members);
        await emitMessage(env, orgId, out.row);
        await queueMessagePushes(env, orgId, out.row, { members }).catch((err) => console.error("push queue failed", safe(err?.message)));
      }
    } catch (err) {
      console.error("agent answer failed", safe(err?.message));
      // Failed on the way: still a line in the thread, never silence.
      try {
        const out = await postMessage(env.DB, { orgId, key: resolved.key, authorLogin: `agent:${agent.id}`, body: serverText(locale, "agent.failedError"), kind: "agent", parentId });
        if (out.row) await broadcastWithParent(env, orgId, resolved, out.row, members);
      } catch { /* the database itself is down: nothing more to say */ }
    }
    await progress(agent, "done");
  };
  await Promise.all(agents.map((agent, index) => answerOne(agent, index).catch((err) => console.error("agent turn failed", safe(err?.message)))));
  if (provider) await settleUsage(env.DB, provider, { orgId, githubId: session.github_id });
  return answered;
}

/// Where a teammate's words go: under the message that called it, or, in a
/// conversation with it, into the conversation itself ("-").
const teammateParent = (resolved, row) => row.parent_id || (resolved.kind === "agent" ? null : row.id);

/// An AI teammate's turn (teammates.js): the thread handed to it, a line
/// saying it has started, and its answer when it has one — watched here
/// while this request may still run, and by the minute cron after that.
async function runTeammate(env, { orgId, user, resolved, row, members, locale, agent, t, deadline }) {
  const parentId = teammateParent(resolved, row);
  const say = async (key) => {
    const out = await postMessage(env.DB, { orgId, key: resolved.key, authorLogin: `agent:${agent.id}`, body: serverText(locale, key), kind: "agent", parentId });
    if (out.row) {
      await broadcastWithParent(env, orgId, resolved, out.row, members);
      await emitMessage(env, orgId, out.row);
    }
  };
  if (!t) return say("teammate.off");
  let started;
  try {
    const transcript = await contextFor(env.DB, orgId, resolved.key, row).catch(() => []);
    const where = resolved.kind === "business" ? `the #${resolved.slug} channel` : resolved.kind === "agent" ? "a direct conversation with you" : "a direct conversation";
    started = await startTeammateRun(env, {
      orgId, t, key: resolved.key, threadId: parentId || "-", where, askedBy: user.name || "a teammate",
      transcript, request: requestFor(row.body, agent), login: user.login,
    });
  } catch (err) {
    console.error("teammate start failed", safe(err?.message));
    return say("teammate.failed");
  }
  if (started.refused) return say(started.refused === "limit" ? "teammate.limit" : started.refused === "busy" ? "teammate.busy" : "teammate.notHere");
  await say(started.continued ? "teammate.continued" : "teammate.started");
  await watchTeammateRuns(env, { ids: [started.run.id], deadline });
}

/// Look in on teammates at work, and post what each finished with into the
/// thread it came from. Once (the minute cron), or until `deadline`.
export async function watchTeammateRuns(env, { ids = null, deadline = 0, pause = 8000 } = {}) {
  for (;;) {
    const runs = await openRuns(env.DB, { ids });
    if (!runs.length) return;
    let working = 0;
    for (const run of runs) {
      working += 1;
      try {
        const t = await loadTeammate(env.DB, run.org_id, run.provider);
        const read = canSignIn(t) ? await readRun(env, t, run) : { texts: [], stop: "terminated", last: null, costCents: null };
        const status = await settleRun(env.DB, run, read);
        if (read.stop || status) working -= 1;
        if (status) await postTeammateResult(env, run, t, read, status);
      } catch (err) {
        console.error("teammate watch failed", safe(err?.message));
      }
    }
    if (!working || Date.now() + pause + 5000 > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

async function postTeammateResult(env, run, t, read, status) {
  const starter = run.started_by ? await getUserByLogin(env.DB, run.started_by).catch(() => null) : null;
  const locale = await loadCopy(env, starter?.locale || "en", { orgId: run.org_id });
  const words = read.texts.join("\n\n").trim();
  let body;
  if (status === "budget") body = [words, serverText(locale, "teammate.budget")].filter(Boolean).join("\n\n");
  else if (status === "failed") body = [words, serverText(locale, read.stop === "terminated" ? "teammate.failed" : "teammate.stopped")].filter(Boolean).join("\n\n");
  else body = words || (read.error ? serverText(locale, "teammate.stopped") : serverText(locale, "teammate.done"));
  const agentId = t?.agentId;
  if (!agentId) return;
  // Working for a person who was mentioned: what it would post outside the
  // chat waits on that person (proxy.js), and the answer reads as theirs.
  if (run.on_behalf_of) {
    body = await proxyTeammateAnswer(env, { orgId: run.org_id, run, body, agentLogin: `agent:${agentId}` })
      .catch((err) => { console.error("proxy answer failed", safe(err?.message)); return body; });
  }
  const out = await postMessage(env.DB, {
    orgId: run.org_id, key: run.channel, authorLogin: `agent:${agentId}`, body: body.length > MAX_MESSAGE_CHARS ? `${body.slice(0, MAX_MESSAGE_CHARS - 1)}…` : body, kind: "agent",
    parentId: run.thread_id === "-" ? null : run.thread_id, onBehalfOf: run.on_behalf_of || null,
  });
  if (out.row) await broadcastStored(env, run.org_id, run.channel, out.row);
}

/// The sidebar's previews in the language the reader set: kept translations
/// at once, new ones by the model in one batch.
async function previewsInLanguage(env, orgId, user, items) {
  const rows = items.map((i) => i._row).filter((r) => r?.body);
  let byId = {};
  if (rows.length && Number(user.translate_messages ?? 1) !== 0) {
    try {
      const provider = await providerFor(env, orgId);
      ({ byId } = await translateMessages(env.DB, orgId, rows, { locale: String(user.locale || "en").slice(0, 2), provider }));
    } catch (err) {
      console.error("preview translation failed", safe(err?.message));
    }
  }
  return items.map(({ _row, ...item }) => {
    const text = _row && byId[_row.id];
    return text && text.trim() !== String(_row.body).trim() ? { ...item, preview: text.replace(/\s+/g, " ").trim().slice(0, 120) } : item;
  });
}

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
      activity: await previewsInLanguage(env, orgId, who.user, await channelActivity(env.DB, orgId, who.user.login, members)),
      prefs,
      // Your own away settings, with the delegate as a ref you can show.
      mine: me ? { status: me.status, awayUntil: me.awayUntil, delegateRef: members.find((m) => m.login === me.delegateLogin)?.ref || null } : null,
      // `loginHash` lets a browser tell which member a card it already holds
      // is from — cards carry logins — without being handed anyone's login.
      members: await Promise.all(members.map(async (m) => ({
        ref: m.ref, name: m.name, title: m.title || m.role, mine: m.mine, ...(m.role === "guest" ? { guest: true } : {}),
        handle: m.handle || null, status: m.status || null, awayUntil: m.awayUntil || null, avatarUrl: m.avatarUrl || null,
        loginHash: (await sha256Hex(m.login)).slice(0, 16),
      }))),
      maxChars: MAX_MESSAGE_CHARS,
      // The agents you can call here: the team's and your own.
      agents: await callableAgents(env.DB, orgId, who.user.login, members),
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
    // An app in the sidebar (Automations, Gmail…): looked at, so its count
    // goes on every device. Only the person's own position; nothing else.
    if (typeof body.channel === "string" && /^app:[a-z0-9_-]{1,32}$/.test(body.channel)) {
      const who = await caller(env, request, body.orgId);
      if (who.denied) return who.denied;
      const lastReadAt = await markRead(env.DB, body.orgId, who.user.login, body.channel, body.at);
      after(() => announceTo(env, body.orgId, [{ to: who.user.login, event: customEvent("reads_changed", { view: body.channel, thread: null, lastReadAt }) }]));
      return json({ lastReadAt });
    }
    if (body.channel === "activity") {
      const who = await caller(env, request, body.orgId);
      if (who.denied) return who.denied;
      // The ones looked at: gone from every device's Activity.
      if (Array.isArray(body.items)) {
        const items = await markActivitySeen(env.DB, body.orgId, who.user.login, body.items);
        // A reply among them is read in its thread too: Threads agrees.
        const threads = items.length ? await readThreadsSeenInActivity(env.DB, body.orgId, who.user.login, items) : [];
        if (items.length) after(() => readEverywhere(env, body.orgId, who.user.login, { items, threads }));
        return json({ items, threads });
      }
      // "Mark all as read": every item new now is looked at, its replies
      // read in their threads too, and the inbox read up to now.
      const members = await listMembers(env.DB, body.orgId, who.session.github_id);
      const { items: all } = await activityFeed(env.DB, body.orgId, who.user.login, members);
      const newKeys = all.filter((i) => i.unread).map((i) => i.key).filter((k) => /^(m|r):/.test(k || ""));
      const items = await markActivitySeen(env.DB, body.orgId, who.user.login, newKeys);
      const threads = items.length ? await readThreadsSeenInActivity(env.DB, body.orgId, who.user.login, items) : [];
      const lastReadAt = await markRead(env.DB, body.orgId, who.user.login, "activity", body.at);
      if (items.length) after(() => readEverywhere(env, body.orgId, who.user.login, { items, threads }));
      return json({ lastReadAt, items, threads });
    }
    // Threads' "Mark all as read": each thread with a new reply read up to
    // its newest; Activity drops those replies as it does for any thread read.
    if (body.channel === "threads") {
      const who = await caller(env, request, body.orgId);
      if (who.denied) return who.denied;
      const members = await listMembers(env.DB, body.orgId, who.session.github_id);
      const open = (await threadsFor(env.DB, body.orgId, who.user.login, members)).filter((x) => x.unread);
      const threads = [];
      for (const x of open) {
        const lastReadAt = await markRead(env.DB, body.orgId, who.user.login, `t:${x.parent.id}`, x.lastReplyAt);
        threads.push({ thread: x.parent.id, lastReadAt, view: x.parent.channel });
      }
      if (threads.length) {
        after(async () => {
          await announceTo(env, body.orgId, [{ to: who.user.login, event: customEvent("reads_changed", { items: [], threads: threads.map(({ thread, lastReadAt }) => ({ thread, lastReadAt })) }) }]);
          for (const t of threads) {
            const row = await getMessage(env.DB, body.orgId, t.thread);
            if (row) await clearDelivered(env, body.orgId, who.user.login, { key: row.channel, view: t.view, thread: t.thread, lastReadAt: t.lastReadAt }).catch(() => {});
          }
        });
      }
      return json({ threads: threads.map(({ thread, lastReadAt }) => ({ thread, lastReadAt })) });
    }
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    const login = ctx.who.user.login;
    // One thread in it: Threads stops calling it unread.
    if (body.thread) {
      const parent = await getMessage(env.DB, body.orgId, String(body.thread));
      if (!parent || parent.channel !== ctx.resolved.key) return json({ message: "No such thread." }, 404);
      const lastReadAt = await markRead(env.DB, body.orgId, login, `t:${parent.id}`, body.at);
      // Its first message, where it named you, is read in Activity too.
      const parentItems = await markActivitySeen(env.DB, body.orgId, login, [`m:${parent.id}`]);
      after(async () => {
        await readEverywhere(env, body.orgId, login, { view: ctx.view, key: ctx.resolved.key, thread: parent.id, lastReadAt });
        if (parentItems.length) await readEverywhere(env, body.orgId, login, { items: parentItems });
      });
      return json({ lastReadAt });
    }
    const lastReadAt = await markRead(env.DB, body.orgId, login, ctx.resolved.key, body.at);
    after(() => readEverywhere(env, body.orgId, login, { view: ctx.view, key: ctx.resolved.key, lastReadAt }));
    return json({ lastReadAt });
  }

  // "Mark unread": back to just before one message, on every device.
  if (path === "/channels/unread" && request.method === "POST") {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    const row = await getMessage(env.DB, body.orgId, String(body.messageId || ""));
    if (!row || row.deleted_at || row.channel !== ctx.resolved.key) return json({ message: "No such message." }, 404);
    const key = row.parent_id ? `t:${row.parent_id}` : ctx.resolved.key;
    const lastReadAt = await markUnreadFrom(env.DB, body.orgId, ctx.who.user.login, key, row.created_at);
    after(() => readEverywhere(env, body.orgId, ctx.who.user.login, { view: ctx.view, thread: row.parent_id || null, lastReadAt, unread: true }));
    return json({ lastReadAt, thread: row.parent_id || null });
  }

  // An agent's picture, in place of its emoji: the image is the body, the
  // workspace and the agent are in the address. Whoever may change the
  // agent may change its picture; DELETE takes it off.
  if (path === "/channels/agents/avatar" && (request.method === "POST" || request.method === "DELETE")) {
    const orgId = url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const limited = await enforce(env, request, "team");
    if (limited) return limited;
    const guest = await isGuest(env.DB, orgId, who.session.github_id);
    const id = url.searchParams.get("id");
    let avatarUrl = null;
    let mediaId = null;
    if (request.method === "POST") {
      const image = await readImage(request);
      if (image.error) return json({ message: image.error }, image.status);
      // Checked before the bytes are kept, so a refusal leaves nothing behind.
      const check = await setAgentAvatar(env.DB, orgId, { id, login: who.user.login, avatarUrl: undefined, isGuest: guest, dryRun: true });
      if (check.error) return json({ message: check.error }, check.status || 400);
      mediaId = `agent-avatar-${crypto.randomUUID()}`;
      await env.MEDIA.put(mediaId, image.bytes, { httpMetadata: { contentType: image.contentType } });
      avatarUrl = `${url.origin}/agents/avatar/${mediaId}`;
    }
    const out = await setAgentAvatar(env.DB, orgId, { id, login: who.user.login, avatarUrl, isGuest: guest });
    if (out.error) {
      if (mediaId) await env.MEDIA.delete(mediaId).catch(() => {});
      return json({ message: out.error }, out.status || 400);
    }
    const old = /\/agents\/avatar\/(agent-avatar-[0-9a-f-]{36})$/.exec(String(out.previous || ""));
    if (old && old[1] !== mediaId) await env.MEDIA.delete(old[1]).catch(() => {});
    if (out.agent.scope === "team") {
      await audit(env, request, { orgId, action: "agent.updated", actor: person(who.user), entity: { type: "agent", id: out.agent.id, name: `@${out.agent.handle}` }, details: { picture: avatarUrl ? "set" : "removed" } });
    }
    const members = await listMembers(env.DB, orgId, who.session.github_id);
    const isAdmin = await allowed(env.DB, orgId, who.session.github_id, "agent.manage_others");
    return json({ agent: toClientAgent(out.agent, members, who.user.login, { isAdmin }) });
  }

  // Agents the team writes: "@hayao" answers as its Markdown instructions
  // say. The list, the presets to start from, and making, changing and
  // deleting one. A team agent is anyone's to improve; deleting it is its
  // maker's or an admin's.
  if (path === "/channels/agents" && ["GET", "POST", "PUT", "DELETE"].includes(request.method)) {
    const body = request.method === "GET" ? { orgId: url.searchParams.get("orgId") } : await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const orgId = body.orgId;
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, orgId, who.session.github_id);
    const isAdmin = await allowed(env.DB, orgId, who.session.github_id, "agent.manage_others");
    const login = who.user.login;
    const list = async () => (await listAgents(env.DB, orgId, login)).map((a) => toClientAgent(a, members, login, { isAdmin }));
    if (request.method === "GET") return json({ agents: await list(), presets: presetsFor(who.user.locale || url.searchParams.get("locale") || "en") });
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const guest = await isGuest(env.DB, orgId, who.session.github_id);
    if (request.method === "DELETE") {
      if (guest) return json({ message: "A guest cannot make or change agents." }, 403);
      const out = await deleteAgent(env.DB, orgId, { id: body.id, login, isAdmin });
      if (out.error) return json({ message: out.error }, out.status || 400);
      if (out.agent.scope === "team") {
        await audit(env, request, { orgId, action: "agent.deleted", actor: person(who.user), entity: { type: "agent", id: out.agent.id, name: `@${out.agent.handle}` } });
      }
      return json({ agents: await list() });
    }
    const out = await saveAgent(env.DB, orgId, {
      id: request.method === "PUT" ? body.id : null, input: body, login, members, isGuest: guest,
    });
    if (out.error) return json({ message: out.error }, out.status || 400);
    if (out.agent.scope === "team") {
      await audit(env, request, {
        orgId, action: out.created ? "agent.created" : "agent.updated", actor: person(who.user),
        entity: { type: "agent", id: out.agent.id, name: `@${out.agent.handle}` },
      });
    }
    return json({ agent: toClientAgent(out.agent, members, login, { isAdmin }), agents: await list() }, out.created ? 201 : 200);
  }

  // User groups: `@sales` names everyone in it. Listed, made and changed by
  // anyone in the workspace; deleted by whoever made it, or an admin.
  if (path === "/channels/usergroups" && ["GET", "POST", "PUT", "DELETE"].includes(request.method)) {
    if (request.method !== "GET") {
      const limited = await enforce(env, request, "team");
      if (limited) return limited;
    }
    const body = request.method === "GET" ? null : await request.json().catch(() => null);
    if (request.method !== "GET" && (!body || typeof body !== "object")) return json({ message: "Invalid JSON body." }, 400);
    const orgId = request.method === "GET" ? url.searchParams.get("orgId") : body.orgId;
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, orgId, who.session.github_id);
    const list = async () => (await groupsIn(env.DB, orgId)).map((g) => toClientGroup(g, members));
    if (request.method === "GET") return json({ groups: await list() });
    if (await isGuest(env.DB, orgId, who.session.github_id)) return json({ message: "A guest cannot change user groups." }, 403);
    if (request.method === "DELETE") {
      const out = await deleteGroup(env.DB, orgId, { handle: body.handle, login: who.user.login, isAdmin: await allowed(env.DB, orgId, who.session.github_id, "usergroup.delete_others") });
      if (out.error) return json({ message: out.error }, out.status || 400);
      return json({ groups: await list() });
    }
    const out = await saveGroup(env.DB, orgId, { handle: body.handle, name: body.name, refs: body.refs, login: who.user.login, members, creating: request.method === "POST" });
    if (out.error) return json({ message: out.error }, out.status || 400);
    return json({ group: toClientGroup(out.group, members), groups: await list() }, request.method === "POST" ? 201 : 200);
  }

  // Your sidebar: what you starred, and the sections you made.
  if (path === "/channels/sidebar" && (request.method === "GET" || request.method === "PUT")) {
    const body = request.method === "PUT" ? await request.json().catch(() => null) : null;
    if (request.method === "PUT" && (!body || typeof body !== "object")) return json({ message: "Invalid JSON body." }, 400);
    const orgId = request.method === "GET" ? url.searchParams.get("orgId") : body.orgId;
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    if (request.method === "GET") return json({ sidebar: await getSidebar(env.DB, orgId, who.user.login) });
    return json({ sidebar: await saveSidebar(env.DB, orgId, who.user.login, body.sidebar || body) });
  }

  // One of your sections folded, or opened again. Only that is written: a
  // window open since the morning says nothing here about your stars.
  if (path === "/channels/sidebar/fold" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const who = await caller(env, request, body.orgId);
    if (who.denied) return who.denied;
    const sidebar = await foldSection(env.DB, body.orgId, who.user.login, body.id, body.collapsed === true);
    if (!sidebar) return json({ message: "No such section." }, 404);
    return json({ sidebar });
  }

  // Threads: every thread you are in, the newest reply first.
  if (path === "/channels/threads" && request.method === "GET") {
    const orgId = url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, orgId, who.session.github_id);
    return json({ threads: await threadsFor(env.DB, orgId, who.user.login, members) });
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
      // `{ messages, more }`: `more` says whether older messages are there
      // to page back to, so a client need not guess it from the count.
      return json(await listMessages(env.DB, orgId, resolved, who.user.login, view, members, { before }));
    }
    const parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : null;
    // An inline reply: the message it answers (postMessage checks it is here).
    const replyTo = typeof body.replyTo === "string" && body.replyTo ? body.replyTo : null;
    if (replyTo && body.sendAt) return json({ message: "A scheduled message cannot be a reply yet." }, 400);
    // A thread reply can go to the conversation as well; anything else is
    // in the conversation already.
    const alsoChannel = Boolean(parentId) && body.alsoChannel === true;
    // The workspace's data rules read it before it is kept, sent now or later.
    const attached = Array.isArray(body.files) && body.files.length
      ? await attachedTexts(env, { orgId, key: resolved.key, login: who.user.login, ids: body.files, githubId: who.session.github_id }).catch(() => [])
      : [];
    const stopped = await checkOutgoing(env, request, { orgId, login: who.user.login, text: typeof body.body === "string" ? body.body : "", files: attached, ack: body.dlpAck === true, where: body.sendAt ? "scheduled" : parentId ? "reply" : "message" });
    if (stopped) return stopped;
    // Written now, sent later.
    if (body.sendAt) {
      const sched = await scheduleMessage(env.DB, { orgId, key: resolved.key, authorLogin: who.user.login, body: body.body, parentId, sendAt: body.sendAt, alsoChannel });
      if (sched.error) return json({ message: sched.error }, 400);
      return json({ scheduled: { ...sched.scheduled, channel: view } }, 201);
    }
    // Files uploaded for this message come with it — yours, uploaded here.
    const fileIds = Array.isArray(body.files) ? body.files : [];
    const withFiles = fileIds.length > 0 && (await claimable(env.DB, { orgId, key: resolved.key, login: who.user.login, ids: fileIds })) > 0;
    if (body.clientId != null && body.clientId !== "" && (typeof body.clientId !== "string" || !clientIdOk(body.clientId))) {
      return json({ message: "That send cannot be tried again." }, 400);
    }
    const clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : null;
    const out = await postMessage(env.DB, { orgId, key: resolved.key, authorLogin: who.user.login, body: typeof body.body === "string" ? body.body : "", parentId, replyTo, withFiles, clientId, alsoChannel });
    if (out.error) return json({ message: out.error, ...(out.code ? { code: out.code } : {}) }, out.status || 400);
    if (out.replay) {
      const [message] = await present(env.DB, orgId, [out.row], who.user.login, view, members);
      return json({ message });
    }
    if (withFiles) await attachFiles(env.DB, { orgId, key: resolved.key, login: who.user.login, messageId: out.row.id, ids: fileIds });
    // A message to an agent is the agent's to do: it never becomes a card
    // for a person, whatever else it says.
    const toAgent = resolved.kind === "agent"
      || agentsCalled(out.row.body, await agentsHere(env.DB, orgId, who.user.login, resolved.key).catch(() => [])).length > 0;
    // A card only when asked for one: sent as a decision, or "@AI" asked,
    // in words, for an approval or a card. Any other "@AI" is a question,
    // and the AI answers it in the thread.
    const calledAI = !toAgent && asksTheAI(out.row.body);
    const wantsDecision = !toAgent && (body.decide === true || (calledAI && asksForDecision(withoutAI(out.row.body))));
    const wantsAnswer = calledAI && !wantsDecision;
    const locale = who.user.locale || "en";
    after(async () => {
      await broadcastWithParent(env, orgId, resolved, out.row, members);
      await emitMessage(env, orgId, out.row);
      // Whoever this is for hears it on their phone in a minute, unless
      // they read it or are at the app by then.
      await queueMessagePushes(env, orgId, out.row, { members }).catch((err) => console.error("push queue failed", safe(err?.message)));
      if (wantsDecision) {
        await decideFromMessage(env, { orgId, session: who.session, user: who.user, resolved, row: out.row, members, route, locale });
      }
      if (wantsAnswer) await answerAsAI(env, { orgId, session: who.session, user: who.user, resolved, row: out.row, members, locale });
      await answerAsAgents(env, { orgId, session: who.session, user: who.user, resolved, row: out.row, members, locale });
      // The people it names who let their agent answer for them.
      await answerAsProxies(env, { orgId, resolved, row: out.row, members, locale })
        .catch((err) => console.error("proxies failed", safe(err?.message)));
    });
    // What you said, you have read.
    if (!parentId || alsoChannel) await markRead(env.DB, orgId, who.user.login, resolved.key, out.row.created_at);
    const [message] = await present(env.DB, orgId, [out.row], who.user.login, view, members);
    // A reply comes back with its parent as it now stands — its count said
    // outright, so a client never adds one to a number the live event may
    // already have raised.
    let parent = null;
    if (parentId) {
      const row = await getMessage(env.DB, orgId, parentId);
      if (row) [parent] = await present(env.DB, orgId, [row], who.user.login, view, members);
    }
    return json({ message, deciding: wantsDecision, ...(parent ? { parent } : {}) }, 201);
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
    if (request.method === "PUT") {
      const stopped = await checkOutgoing(env, request, { orgId: body.orgId, login: ctx.who.user.login, text: typeof body.body === "string" ? body.body : "", ack: body.dlpAck === true, where: "edit" });
      if (stopped) return stopped;
    }
    const out = request.method === "PUT"
      ? await editMessage(env.DB, { orgId: body.orgId, id: body.messageId, authorLogin: ctx.who.user.login, body: body.body })
      : await deleteMessage(env.DB, { orgId: body.orgId, id: body.messageId, authorLogin: ctx.who.user.login, withThread: body.withThread === true });
    if (out.error) return json({ message: out.error, ...(out.code ? { code: out.code, others: out.others } : {}) }, out.status || 400);
    // Unsent: its files go with its words.
    if (request.method === "DELETE") {
      for (const mid of [body.messageId, ...(out.replies || [])]) await dropFiles(env, body.orgId, mid);
    }
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
    const stopped = await checkOutgoing(env, request, { orgId: body.orgId, login: who.user.login, text, ack: body.dlpAck === true, where: "daily_report" });
    if (stopped) return stopped;
    const members = await listMembers(env.DB, body.orgId, who.session.github_id);
    // The team's daily-report channel, even for a draft made while its
    // routine still pointed elsewhere.
    const resolved = await resolveChannel(env.DB, body.orgId, who.user, await dailyChannelFor(env.DB, body.orgId, card.dailyReport.channel), members);
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

  // A daily report's draft its owner does not want to send: put away, on
  // every device, without a word in the channel.
  if (path === "/channels/daily-report/draft" && request.method === "DELETE") {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || typeof body.cardId !== "string") return json({ message: "Invalid JSON body." }, 400);
    const who = await caller(env, request, body.orgId);
    if (who.denied) return who.denied;
    const card = await getCard(env.DB, body.orgId, body.cardId);
    if (!card?.dailyReport || card.recipientUserID !== who.user.login) return json({ message: "No such draft." }, 404);
    if (!(await discardDraft(env.DB, body.orgId, card.id))) return json({ message: "This report has already been posted." }, 409);
    const closed = await getCard(env.DB, body.orgId, card.id);
    await appendCardEvent(env.DB, body.orgId, { cardId: card.id, type: "decided", action: "dismiss", actorUserId: who.user.login, note: "draft discarded", snapshot: closed });
    after(async () => { if (closed) await announceCards(env, body.orgId, [closed], { isNew: false }); });
    return json({ card: closed });
  }

  // A daily report's draft, kept as its owner edits it (PUT), or changed by
  // the AI the way they ask (POST refine). Only its owner, only a draft.
  if ((path === "/channels/daily-report/draft" && request.method === "PUT") || (path === "/channels/daily-report/refine" && request.method === "POST")) {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || typeof body.cardId !== "string") return json({ message: "Invalid JSON body." }, 400);
    const who = await caller(env, request, body.orgId);
    if (who.denied) return who.denied;
    const card = await getCard(env.DB, body.orgId, body.cardId);
    if (!card?.dailyReport || card.recipientUserID !== who.user.login) return json({ message: "No such draft." }, 404);
    if (card.dailyReport.status !== "draft") return json({ message: "This report has already been posted." }, 409);
    const text = String(typeof body.text === "string" ? body.text : card.dailyReport.text || "");
    if (text.length > MAX_MESSAGE_CHARS) return json({ message: `A message is at most ${MAX_MESSAGE_CHARS} characters.` }, 400);
    let note = null;
    let next = text;
    if (path.endsWith("/refine")) {
      const ask = typeof body.ask === "string" ? body.ask.trim() : "";
      if (!ask) return json({ message: "Say what to change." }, 400);
      const userKey = request.headers.get("x-ai-key") || undefined;
      const provider = await providerFor(env, body.orgId, userKey);
      const allowance = provider ? await allowanceFor(env, body.orgId, { githubId: String(who.session.github_id), userKey }) : null;
      const out = await refineDailyReport(text, ask, { locale: who.user.locale || "en", provider, allowance });
      next = out.text; note = out.note;
    }
    await saveDraftText(env.DB, body.orgId, card.id, next);
    const saved = await getCard(env.DB, body.orgId, card.id);
    after(async () => { if (saved) await announceCards(env, body.orgId, [saved], { isNew: false }); });
    return json({ card: saved, text: next, note });
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

  // A link's card under the message that shares it: title, a line, a
  // picture, and for a video what it takes to play it here (preview.js).
  // Members only, so this is nobody's open proxy.
  if (path === "/channels/link-preview" && request.method === "GET") {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const session = await getSession(env.DB, request.headers.get("x-session-token"));
    if (!session) return json({ message: "Please sign in." }, 401);
    const orgId = url.searchParams.get("orgId") || "";
    if (!orgId || !(await isMember(env.DB, orgId, session.github_id))) return json({ message: "not a member of this org" }, 403);
    const target = String(url.searchParams.get("url") || "").slice(0, 2000);
    const { cachedPreview } = await import("./preview.js");
    const out = await cachedPreview(target);
    return json(out);
  }

  // A private channel's members: anyone inside may bring somebody in, or
  // take somebody out; anyone may leave.
  // Messages in another language, in this reader's: translated once per
  // message and language and kept (translate.js). Only messages in this
  // conversation; only for a reader who has not turned translation off.
  if (path === "/channels/translate" && request.method === "POST") {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || !Array.isArray(body.ids)) return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    const me = ctx.who.user;
    // The language the reader set: what their screen says it is, else
    // what their profile holds.
    const asked = String(body.locale || "").slice(0, 2).toLowerCase();
    const locale = /^[a-z]{2}$/.test(asked) ? asked : String(me.locale || "en").slice(0, 2);
    if (Number(me.translate_messages ?? 1) === 0) return json({ translations: {}, locale, off: true });
    const ids = [...new Set(body.ids.map(String))].slice(0, 60);
    const rows = (await Promise.all(ids.map((id) => getMessage(env.DB, body.orgId, id)))).filter((r) => r && r.channel === ctx.resolved.key);
    const provider = await providerFor(env, body.orgId);
    const allowance = provider ? await allowanceFor(env, body.orgId, { githubId: String(ctx.who.session.github_id) }) : null;
    const { byId } = await translateMessages(env.DB, body.orgId, rows, { locale, provider, allowance });
    if (provider) await settleUsage(env.DB, provider, { orgId: body.orgId, githubId: ctx.who.session.github_id });
    return json({ translations: byId, locale });
  }

  // An agent brought into a channel or a group, or taken out of it. Anyone
  // in it but a guest may do either; only an agent you can call yourself
  // can be brought in — your own personal one included.
  if (path === "/channels/channel-agents" && (request.method === "POST" || request.method === "DELETE")) {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || typeof body.agentId !== "string") return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    if (ctx.resolved.kind !== "business" && ctx.resolved.kind !== "group") return json({ message: "Agents are added to a channel or a group." }, 400);
    const orgId = body.orgId;
    const me = ctx.who.user;
    if (await isGuest(env.DB, orgId, ctx.who.session.github_id)) return json({ message: "A guest cannot add or remove agents." }, 403);
    const key = ctx.resolved.key;
    const locale = await loadCopy(env, me.locale || "en", { orgId });
    const note = async (text) => {
      const out = await postMessage(env.DB, { orgId, key, authorLogin: null, body: text, kind: "ai" });
      if (out.row) await broadcast(env, orgId, ctx.resolved, out.row, ctx.members);
    };
    const who = ctx.members.find((m) => m.login === me.login)?.name || me.name || me.login;
    const label = (a) => `${a.emoji ? `${a.emoji} ` : ""}${a.name} (@${a.handle})`;
    if (request.method === "POST") {
      const agent = (await listAgents(env.DB, orgId, me.login)).find((a) => a.id === body.agentId);
      if (!agent) return json({ message: "No such agent." }, 404);
      if ((await channelAgents(env.DB, orgId, key)).some((a) => a.handle === agent.handle && a.id !== agent.id)) {
        return json({ message: `An agent called @${agent.handle} is already here.` }, 409);
      }
      if (!(await addChannelAgent(env.DB, { orgId, key, agentId: agent.id, login: me.login }))) return json({ added: false });
      await note(serverText(locale, "channel.agentAdded", { who, name: label(agent) }));
      await audit(env, request, { orgId, action: "channel.agent_added", actor: person(me), entity: { type: "agent", id: agent.id, name: `@${agent.handle}` }, details: { channel: ctx.resolved.slug ? `#${ctx.resolved.slug}` : "group" } });
      return json({ added: true });
    }
    const agent = (await channelAgents(env.DB, orgId, key)).find((a) => a.id === body.agentId);
    if (!agent || !(await removeChannelAgent(env.DB, { orgId, key, agentId: agent.id }))) return json({ message: "That agent is not here." }, 404);
    await note(serverText(locale, "channel.agentRemoved", { who, name: label(agent) }));
    await audit(env, request, { orgId, action: "channel.agent_removed", actor: person(me), entity: { type: "agent", id: agent.id, name: `@${agent.handle}` }, details: { channel: ctx.resolved.slug ? `#${ctx.resolved.slug}` : "group" } });
    return json({ removed: true });
  }

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
      // One entry per person, who is the entity — so their name goes under
      // their own key, never into the details in the clear.
      for (const m of adding) {
        await audit(env, request, { orgId, action: "channel.member_added", actor: person(me), entity: { type: "user", id: m.login, name: m.name }, details: { channel: `#${ctx.resolved.slug}` } });
      }
      return json({ added: adding.length });
    }
    const target = body.ref ? ctx.members.find((m) => m.ref === String(body.ref)) : ctx.members.find((m) => m.login === me.login);
    if (!target || !ctx.resolved.logins.includes(target.login)) return json({ message: "They are not in this channel." }, 404);
    await removeMember(env.DB, { orgId, key, login: target.login });
    await announceTo(env, orgId, [await listFor(target.login)]);
    await note(target.login === me.login
      ? serverText(locale, "channel.left", { who: nameOf(me.login) })
      : serverText(locale, "channel.removed", { who: nameOf(me.login), name: target.name }));
    await audit(env, request, { orgId, action: "channel.member_removed", actor: person(me), entity: { type: "user", id: target.login, name: target.name }, details: { channel: `#${ctx.resolved.slug}`, left: target.login === me.login } });
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

  // The canvas: one shared document per conversation.
  if (path.startsWith("/channels/canvas") && ["/channels/canvas", "/channels/canvas/revision", "/channels/canvas/draft"].includes(path)) {
    const reading = request.method === "GET";
    if (!reading && !(request.method === "PUT" && path === "/channels/canvas") && !(request.method === "POST" && path === "/channels/canvas/draft")) return json({ message: "not found" }, 404);
    const body = reading ? { orgId: url.searchParams.get("orgId"), channel: url.searchParams.get("channel") } : await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    const key = ctx.resolved.key;
    const login = ctx.who.user.login;
    if (reading && path === "/channels/canvas") {
      return json({ canvas: toClientCanvas(await getCanvas(env.DB, body.orgId, key), ctx.members), revisions: await listRevisions(env.DB, body.orgId, key, ctx.members) });
    }
    if (reading && path === "/channels/canvas/revision") {
      const row = await getRevision(env.DB, body.orgId, key, parseInt(url.searchParams.get("version"), 10));
      if (!row) return json({ message: "No such version." }, 404);
      return json({ revision: toClientCanvas(row, ctx.members) });
    }
    const limited = await enforce(env, request, path.endsWith("/draft") ? "ai/route" : "chat");
    if (limited) return limited;
    if (path.endsWith("/draft")) {
      const current = await getCanvas(env.DB, body.orgId, key);
      const source = typeof body.body === "string" ? body.body : (current?.body || "");
      const { results } = await env.DB.prepare(
        `SELECT m.body, m.created_at, m.kind, m.author_login FROM channel_messages m
          WHERE m.org_id = ?1 AND m.channel = ?2 AND m.deleted_at IS NULL AND m.body != '' ORDER BY m.created_at DESC LIMIT 150`
      ).bind(body.orgId, key).all();
      const messages = (results || []).reverse().map((r) => ({
        at: r.created_at, text: String(r.body).slice(0, 1000),
        who: r.kind === "ai" ? "AI" : (ctx.members.find((m) => m.login === r.author_login)?.name || "someone"),
      }));
      const userKey = request.headers.get("x-ai-key") || undefined;
      const provider = await providerFor(env, body.orgId, userKey);
      const allowance = provider ? await allowanceFor(env, body.orgId, { githubId: String(ctx.who.session.github_id), userKey }) : null;
      const locale = ctx.who.user.locale || "en";
      const out = await draftCanvas({ body: source, messages, locale, provider, allowance, unavailableNote: serverText(locale, "canvas.draftUnavailable") });
      return json(out);
    }
    const out = await saveCanvas(env.DB, { orgId: body.orgId, key, body: body.body, baseVersion: body.baseVersion, login });
    if (out.error) return json({ message: out.error }, out.status || 400);
    if (out.conflict) return json({ message: "Someone else changed the canvas while you were editing.", canvas: toClientCanvas(out.current, ctx.members) }, 409);
    const canvas = toClientCanvas(out.canvas, ctx.members);
    if (!out.unchanged) {
      // Everyone in the conversation hears that it changed; they fetch it.
      const event = (view) => customEvent("channel_canvas", { channel: view, version: canvas.version, updatedBy: canvas.updatedBy });
      after(async () => {
        if (ctx.resolved.kind === "business" && !ctx.resolved.logins) await announceEvents(env, body.orgId, [event(key)]);
        else await announceTo(env, body.orgId, ctx.resolved.logins.map((to) => ({ to, event: event(viewOf(key, to, ctx.members)) })));
      });
    }
    return json({ canvas, revisions: await listRevisions(env.DB, body.orgId, key, ctx.members) });
  }

  // Bookmarks: links kept at the top of a conversation.
  if (path === "/channels/bookmarks" && ["GET", "POST", "PUT", "DELETE"].includes(request.method)) {
    const body = request.method === "GET" ? { orgId: url.searchParams.get("orgId"), channel: url.searchParams.get("channel") } : await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    const login = ctx.who.user.login;
    const list = async () => (await listBookmarks(env.DB, body.orgId, ctx.resolved.key)).map((b) => toClientBookmark(b, ctx.members, login));
    if (request.method === "GET") return json({ bookmarks: await list() });
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    let out;
    if (request.method === "POST") out = await addBookmark(env.DB, { orgId: body.orgId, key: ctx.resolved.key, title: body.title, url: body.url, login });
    else if (request.method === "PUT") out = await editBookmark(env.DB, { orgId: body.orgId, key: ctx.resolved.key, id: String(body.id || ""), title: body.title, url: body.url });
    else out = await removeBookmark(env.DB, { orgId: body.orgId, key: ctx.resolved.key, id: String(body.id || ""), login, isAdmin: await allowed(env.DB, body.orgId, ctx.who.session.github_id, "bookmark.remove_others") });
    if (out.error) return json({ message: out.error }, out.status || 400);
    // Everyone in the conversation sees the bar change, each in their terms
    // — though a bookmark carries no one's login, only names.
    const rows = await listBookmarks(env.DB, body.orgId, ctx.resolved.key);
    after(async () => {
      if (ctx.resolved.kind === "business" && !ctx.resolved.logins) {
        await announceEvents(env, body.orgId, [customEvent("channel_bookmarks", { channel: ctx.resolved.key, bookmarks: rows.map((b) => toClientBookmark(b, ctx.members, null)) })]);
        return;
      }
      await announceTo(env, body.orgId, ctx.resolved.logins.map((to) => ({
        to, event: customEvent("channel_bookmarks", { channel: viewOf(ctx.resolved.key, to, ctx.members), bookmarks: rows.map((b) => toClientBookmark(b, ctx.members, to)) }),
      })));
    });
    return json({ bookmarks: rows.map((b) => toClientBookmark(b, ctx.members, login)) }, request.method === "POST" ? 201 : 200);
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

  // Its author takes a message's link cards off (or back on).
  if (path === "/channels/previews" && request.method === "POST") {
    const limited = await enforce(env, request, "chat");
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const ctx = await inChannel(env, request, body);
    if (ctx.denied) return ctx.denied;
    const current = typeof body.messageId === "string" ? await getMessage(env.DB, body.orgId, body.messageId) : null;
    if (!current || current.channel !== ctx.resolved.key) return json({ message: "No such message." }, 404);
    const out = await setPreviewsHidden(env.DB, { orgId: body.orgId, id: body.messageId, login: ctx.who.user.login, hidden: body.hidden !== false });
    if (out.error) return json({ message: out.error }, out.status || 400);
    after(() => broadcastWithParent(env, body.orgId, ctx.resolved, out.row, ctx.members));
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
  // Your agent, answering for you when you are mentioned (proxy.js).
  if (path === "/channels/proxy" && (request.method === "GET" || request.method === "PUT")) {
    const body = request.method === "GET" ? { orgId: url.searchParams.get("orgId") } : await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const who = await caller(env, request, body.orgId);
    if (who.denied) return who.denied;
    if (request.method === "GET") return json({ proxy: await getProxy(env.DB, body.orgId, who.user.login) });
    if (await isGuest(env.DB, body.orgId, who.session.github_id)) return json({ message: "A guest cannot have an agent answer for them." }, 403);
    const members = await listMembers(env.DB, body.orgId, who.session.github_id);
    const out = await saveProxy(env.DB, body.orgId, who.user, body, members);
    if (out.error) return json({ message: out.error }, out.status || 400);
    return json(out);
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
      // Decisions meant for you go to them while you are away — about any
      // channel, private ones too — so not to a guest, who sees only theirs.
      if (d.role === "guest") return json({ message: "A guest cannot decide for you. Pick a member of this workspace." }, 400);
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
    // The agents added here, and the ones this person could add.
    const placesAgents = ctx.resolved.kind === "business" || ctx.resolved.kind === "group";
    const guest = placesAgents ? await isGuest(env.DB, orgId, ctx.who.session.github_id) : true;
    const here = placesAgents ? await channelAgents(env.DB, orgId, ctx.resolved.key) : [];
    const nameOf = (login) => ctx.members.find((m) => m.login === login)?.name || null;
    const custom = here.map((a) => ({
      kind: "custom", id: a.id, handle: a.handle, name: a.name, emoji: a.emoji, avatarUrl: a.avatarUrl || null, description: a.description, scope: a.scope,
      owner: nameOf(a.addedBy), canRemove: !guest,
    }));
    const hereIds = new Set(here.map((a) => a.id));
    const hereHandles = new Set(here.map((a) => a.handle));
    const addable = guest ? [] : (await listAgents(env.DB, orgId, ctx.who.user.login))
      .filter((a) => !hereIds.has(a.id) && !hereHandles.has(a.handle))
      .map((a) => ({ id: a.id, handle: a.handle, name: a.name, emoji: a.emoji, avatarUrl: a.avatarUrl || null, description: a.description, scope: a.scope }));
    const agents = [...details.members.agents.slice(0, 1), ...custom, ...details.members.agents.slice(1)];
    return json({
      ...details,
      channel: { ...details.channel, view: ctx.view },
      members: { ...details.members, agents },
      counts: { ...details.counts, members: details.counts.members + custom.length },
      addableAgents: placesAgents ? addable : null,
    });
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
    after(() => (ctx.resolved.logins
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

  // Sent: what you said, newest first, where you can still read it — the
  // "Drafts & sent" list of a chat client.
  if (path === "/channels/sent" && request.method === "GET") {
    const orgId = url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const members = await listMembers(env.DB, orgId, who.session.github_id);
    const access = await accessFor(env.DB, orgId, who.user.login);
    const items = [];
    for (const r of await listSent(env.DB, orgId, who.user.login)) {
      const view = viewOf(r.channel, who.user.login, members, access);
      if (!view) continue;
      const [message] = await present(env.DB, orgId, [r], who.user.login, view, members);
      items.push(message);
      if (items.length >= 50) break;
    }
    return json({ items });
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
  if (key.startsWith("b:")) resolved = logins ? { key, kind: "business", slug: key.slice(2), private: await isPrivate(env.DB, orgId, key.slice(2)), logins } : { key, kind: "business", slug: key.slice(2) };
  else if (key.startsWith("dm:")) resolved = { key, kind: "dm", logins };
  else if (key.startsWith("g:")) resolved = { key, kind: "group", logins };
  else if (key.startsWith("ag:")) resolved = { key, kind: "agent", logins };
  else return;
  await broadcastWithParent(env, orgId, resolved, row, members);
  await emitMessage(env, orgId, row);
  await queueMessagePushes(env, orgId, row, { members }).catch(() => {});
}
