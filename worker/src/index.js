import { routeInstruction } from "./routing.js";
import { toolManifest } from "./agui/tools.js";
import { signup, login, createInvite, acceptInvite, isGitHubSession, inviteLink, peekInvite } from "./auth.js";
import { requestCode, verifyCode } from "./otp.js";
import {
  createSession, getSession, upsertUser, upsertMembership, upsertAgent, isMember, listOrgNodes,
  getConnectorConfig, setConnectorConfig, rememberPullWorkspace, pullWorkspaceOf, createOAuthState, consumeOAuthState,
  getUserByGithubId, registerDevice, removeDevice, retainMemberships, cardsCreatedSince,
  isIngested, markIngested, saveCard,
  saveCardLocalization, setUserLocale, setUserNotifyEmail, setUserEmail, normalizeLocale,
  registerSubscription, removeSubscription, listBusinesses, hasPrivateBusinesses, upsertBusiness, removeBusiness, businessSlug, renameBusiness, unfileBusiness,
  rememberConnections, getCard, normalizeAliases, setUserAliases, parseAliases,
  setOwnTitle, ownTitle, SELF_ASSIGNABLE_ROLES, listUserOrgs, primaryOrgId,
  loadContexts, saveContext, cleanName, checkHandle, setUserName, setUserHandle, MAX_NAME_CHARS,
} from "./db.js";
import { enforce } from "./ratelimit.js";
import { announceCards, evictMember, announceEvents, announceTo } from "./announce.js";
import { custom as customEvent } from "./agui/events.js";
import { contextEvents } from "./agui/adapter.js";
import { verifyMailgunWebhook, parseMailgunWebhook, inboundTokenFromAddress, userForInboundAddress, inboundAddressFor } from "./connectors/email.js";
import { triageMessage } from "./triage.js";
import { notifyCard, anyChannelConfigured } from "./notify.js";
import { proxyGitHub } from "./githubProxy.js";
import { deleteAccount, exportAccount } from "./account.js";
import { listMembers, listMembersForClient, removeMember, listInvites, revokeInvite, membershipIsOurs, returnOrphanedCards } from "./team.js";
import { authorizeOrgAccess } from "./membership.js";
import { isConfigured, isDeviceToken } from "./apns.js";
import { isWebPushConfigured, parseSubscription } from "./webpush.js";
import { isMailConfigured, sendMail } from "./mailer.js";
import { SUPPORTED_LOCALES, composeInviteEmail, t } from "./notifyCopy.js";
import { loadCopy } from "./copy.js";
import { createTeam, renameTeam, teamName, canRename } from "./orgs.js";
import { settleUsage, jevEntry } from "./ledger.js";
import { runScheduledSync, runAutomations } from "./scheduled.js";
import { handleAutomation } from "./automation.js";
import { handleChannels, broadcastStored } from "./channelRoutes.js";
import { handleSuggestions } from "./suggest.js";
import { handleWebhooks } from "./webhooks.js";
import { handleAgentInvites } from "./agentInvites.js";
import { handleUserAvatar } from "./userAvatar.js";
import { serveFile } from "./files.js";
import { addMembers, membersOf, isPrivate, mayRead, accessFor } from "./access.js";
import { runMinuteJobs } from "./later.js";
import { recentBusinessTalk } from "./channels.js";
import { relevantMemories } from "./memory.js";
import { logJSON, routeLabel, safe } from "./log.js";
import {
  recordFeedback, orgMetrics, recipientLoad, recentDecisions, exportGolden, searchDecisions,
  FEEDBACK_VERDICTS, FEEDBACK_REASONS,
} from "./insights.js";
import { answerQuestion, searchTermsFor } from "./ask.js";
import { draftReply } from "./draft.js";
import { providerFor, jevFor, aiStatus, saveAISettings } from "./orgAI.js";
import { githubStatus, connectWorkspaceGitHub, connectWorkspaceGitHubAs, disconnectWorkspaceGitHub, githubConnectLink, listMyRepositories, myGithubAccount, getWorkspaceGitHub } from "./githubWorkspace.js";
import { localizeCard, needsLocalizing, localizeForRecipient } from "./localize.js";
import { primaryLanguage, languageName } from "./language.js";
import { connectedSources, lookupsFor, searchNotion, searchGithubIssues } from "./context.js";
import { ingestedItemForCard } from "./db.js";
import { alert } from "./alert.js";
import { serverText } from "./serverCopy.js";
import { listCardEvents, listOrgEvents, appendCardEvent, withActorNames } from "./events.js";
import { listComments, addComment, listReactions, toggleReaction, REACTIONS, MAX_COMMENT_CHARS } from "./threads.js";
import { fetchCollaborators } from "./github.js";
import { buildOrgGraph, roleName } from "./org.js";
import { uploadMedia, serveMedia } from "./media.js";
import { uploadOrgIcon, removeOrgIcon, serveOrgIcon, getOrgIcon, iconsFor, iconUrl } from "./orgIcon.js";
import { CONNECTORS, connectorById, authConfigFor, availableConnectors } from "./connectors/index.js";
import { createConnectLink, listConnectedAccounts, executeTool } from "./composio.js";
import { syncAll } from "./sync.js";
import { checkAIAllowance, allowanceFor } from "./gate.js";
import { billingStatus } from "./plans.js";
import { complimentaryAvailable, limitRedemption, readRedemptionCode, redeemComplimentaryAccess, prepareComplimentaryDeletion } from "./complimentary.js";
import { fileCardUnderBusiness } from "./classify.js";
import { buildRecord, recordToMarkdown } from "./record.js";

// The longest thing `/ai/route` will read as one instruction. A sentence, a
// paragraph, a pasted email — not a document. Not exported: workerd refuses
// to start a Worker whose main module exports anything that is not a handler
// or a function — a number here took the whole deployment down, and the test
// runner (which imports the module differently) never noticed.
const MAX_INSTRUCTION_CHARS = 4000;

export { OrgRelay } from "./relay.js";

/// The language a request was made in, from the header every client sends
/// without being asked: URLSession fills Accept-Language from the device's
/// languages, browsers from their settings. It seeds a new account's locale
/// so the first notification is already in the right language; an explicit
/// choice through PUT /me overrides it and is never overwritten by this.
export function localeFromRequest(request) {
  const header = request.headers.get("accept-language") || "";
  const first = header.split(",")[0]?.trim();
  return normalizeLocale(first);
}

// Returns an error Response when the caller may not read this org's history, or
// null when they may. History is served straight from D1, so unlike the org
// graph — where GitHub enforces access when we call its API — nothing else would
// stop one org reading another's.
/// Work that outlives the response — an announcement, a notification — where
/// the runtime lets it, and inline where it does not.
function after(ctx, work) {
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work());
  else return work();
}

/// A channel somebody may rename or delete: any public one, a private one
/// only from inside.
async function canTouchChannel(db, orgId, slug, login) {
  if (!(await isPrivate(db, orgId, slug))) return true;
  return Boolean(login) && mayRead(`b:${slug}`, await accessFor(db, orgId, login));
}

/// Tell each of these people their own list of channels again — after a
/// private channel they are in was made, changed or deleted.
async function tellMembers(env, orgId, logins) {
  await announceTo(env, orgId, await Promise.all([...new Set(logins)].map(async (login) => ({
    to: login, event: customEvent("businesses", { businesses: await listBusinesses(env.DB, orgId, { viewer: login }) }),
  }))));
}

async function requireMember(env, request, orgId) {
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "invalid session" }, 401);
  if (!(await isMember(env.DB, orgId, session.github_id))) {
    return json({ message: "not a member of this org" }, 403);
  }
  return null;
}

export default {
  // Every 15 minutes, so a decision that arrived in someone's inbox is already
  // a card by the time they look. Nothing here bypasses the free-tier meter:
  // the sync loop checks the same allowance a manual sync does.
  async scheduled(event, env, ctx) {
    // Every minute: scheduled messages and Later reminders, which a person
    // set to a minute and would notice fifteen late.
    if (event?.cron === "* * * * *") {
      ctx.waitUntil(runMinuteJobs(env, { now: new Date(event?.scheduledTime || Date.now()), broadcast: (orgId, key, row) => broadcastStored(env, orgId, key, row) })
        .catch((err) => console.error("minute jobs failed", err?.message || err)));
      return;
    }
    ctx.waitUntil(runScheduledSync(env, ctx));
    // Routines whose hour has come, and once a day the automations the AI
    // would propose. Separate from the sync, so a slow inbox cannot make a
    // Monday report late.
    ctx.waitUntil(runAutomations(env, ctx, new Date(event?.scheduledTime || Date.now())));
  },

  async fetch(request, env, ctx) {
    // Every response carries the id its log line was written under, so a user
    // reporting "it failed" hands over something that finds the line.
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url);
    const route = routeLabel(request.method, url.pathname);
    try {
      const response = await handle(request, env, url, ctx);
      logJSON({ requestId, route, status: response.status, ms: Date.now() - startedAt });
      // A 101 carries the client end of the socket pair on a property, not in
      // the body. Rebuilding it to add a header would hand back a response with
      // no socket attached — every realtime connection, silently dead.
      if (response.status === 101 || response.webSocket) return response;
      const headers = new Headers(response.headers);
      headers.set("x-request-id", requestId);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (err) {
      // An unhandled throw used to become a raw Workers 500 with a stack trace
      // in it. A malformed JSON body was enough.
      logJSON({ requestId, route, status: 500, ms: Date.now() - startedAt, error: safe(err?.message) });
      alert(ctx, env, "unhandled", `${route} ${requestId} ${safe(err?.message)}`);
      return new Response(
        JSON.stringify({ message: "Something went wrong on our side.", requestId }),
        { status: 500, headers: { "content-type": "application/json", "x-request-id": requestId } }
      );
    }
  },
};

async function handle(request, env, url, ctx) {
    // Browsers send a preflight OPTIONS before a cross-origin POST with custom
    // headers. Answer it with the CORS headers and no body.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, x-session-token, x-ai-key, authorization, mcp-session-id, mcp-protocol-version",
          "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        },
      });
    }

    // The workspace's webhooks.
    const hooked = await handleWebhooks(request, env, url);
    if (hooked) return hooked;
    // Agents brought in by link.
    const agentJoin = await handleAgentInvites(request, env, url);
    if (agentJoin) return agentJoin;
    // A person's own photo.
    const avatar = await handleUserAvatar(request, env, url);
    if (avatar) return avatar;
    // A file in a conversation, by its signed address.
    if (request.method === "GET" && url.pathname.startsWith("/files/")) {
      const file = await serveFile(request, env, url);
      if (file) return file;
    }
    // What to tell your AI, from your own work.
    const suggested = await handleSuggestions(request, env, url);
    if (suggested) return suggested;

    // Routines, the playbook, agent tokens and the MCP endpoint.
    const automated = await handleAutomation(request, env, url, ctx);
    if (automated) return automated;

    // Channels: talking, and turning what was said into a decision through
    // /ai/route itself, called in-process with the caller's own session.
    if (url.pathname === "/channels" || url.pathname.startsWith("/channels/")) {
      const channels = await handleChannels(request, env, url, {
        route: (body) => {
          const inner = new Request(new URL("/ai/route", url.origin), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-session-token": request.headers.get("x-session-token") || "",
              ...(request.headers.get("x-ai-key") ? { "x-ai-key": request.headers.get("x-ai-key") } : {}),
              ...(request.headers.get("CF-Connecting-IP") ? { "CF-Connecting-IP": request.headers.get("CF-Connecting-IP") } : {}),
            },
            body: JSON.stringify(body),
          });
          return handle(inner, env, new URL(inner.url), ctx);
        },
        after: (work) => after(ctx, work),
      });
      if (channels) return channels;
    }

        if (url.pathname === "/auth/signup" && request.method === "POST") {
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const body = await request.json().catch(() => ({}));
      const result = await signup(env, { ...body, locale: body.locale || localeFromRequest(request) });
      if (result.error) return json({ message: result.error }, 400);
      return json(result);
    }

    // Signing in with a code sent to your email. Two routes, both
    // unauthenticated and both rate limited like the other credential paths:
    // one mails a code, one trades it for a session. Together they are the
    // only way in that needs nothing you had to have set up beforehand.
    if (url.pathname === "/auth/otp/request" && request.method === "POST") {
      const limited = await enforce(env, request, "otp/request");
      if (limited) return limited;
      const body = await request.json().catch(() => ({}));
      const result = await requestCode(env, {
        email: body.email,
        locale: body.locale || localeFromRequest(request),
      });
      if (result.error) {
        const headers = result.retryAfter ? { "retry-after": String(result.retryAfter) } : undefined;
        return json(
          { message: result.error, ...(result.providerStatus ? { providerStatus: result.providerStatus } : {}) },
          result.status || 400,
          headers
        );
      }
      return json(result);
    }

    if (url.pathname === "/auth/otp/verify" && request.method === "POST") {
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const body = await request.json().catch(() => ({}));
      const result = await verifyCode(env, {
        email: body.email,
        code: body.code,
        name: body.name,
        inviteCode: body.inviteCode,
        locale: body.locale || localeFromRequest(request),
      });
      if (result.error) return json({ message: result.error }, result.status || 400);
      return json(result);
    }

    if (url.pathname === "/auth/login" && request.method === "POST") {
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const body = await request.json().catch(() => ({}));
      const result = await login(env, { email: body.email, password: body.password, inviteCode: body.inviteCode });
      if (result.error) return json({ message: result.error }, 401);
      return json(result);
    }

           if (url.pathname === "/invites/create" && request.method === "POST") {
      // Redeeming or minting a code grants org membership, so both are guessable
      // surfaces and both get the same budget as the other credential routes.
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401);
      const body = await request.json().catch(() => ({}));
      // A session proves who you are, not that you belong to the org you name.
      // Without this check any signed-in account could mint a code — at any
      // role — into a private org, and redeeming it writes the membership row.
      if (!body.orgId || !(await isMember(env.DB, body.orgId, session.github_id))) {
        return json({ message: "You are not a member of this organization." }, 403);
      }
      const result = await createInvite(env, { orgId: body.orgId, createdBy: session.github_id, role: body.role, uses: body.uses, channels: body.channels });
      if (result.error) return json({ message: result.error }, 400);
      return json(result);
    }

    // What a code opens, before it is spent: the team's name, who sent it,
    // the role. The join page reads this so the person sees "Join Acme as a
    // member" and not a hex string. The code is the credential, so an
    // unknown, expired or spent one is answered exactly like a guess.
    if (url.pathname === "/invites/peek" && request.method === "GET") {
      const limited = await enforce(env, request, "invites/peek");
      if (limited) return limited;
      const peek = await peekInvite(env, url.searchParams.get("code") || "");
      if (!peek) return json({ message: "That invite code is not valid." }, 404);
      const { orgId: _orgId, ...shown } = peek;
      return json(shown);
    }

    // An invitation by address. Mints a single-use code for the role and
    // mails it — as a link where the deployment has a web address, as the
    // code either way — in the sender's language, the only one we know
    // before the invitee has an account. Same budget as minting a code by
    // hand: each of these is a credential, and a mail.
    if (url.pathname === "/invites/email" && request.method === "POST") {
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401);
      if (!isMailConfigured(env)) return json({ message: "This deployment cannot send email yet. Share the code instead." }, 503);
      const body = await request.json().catch(() => ({}));
      const to = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 254) return json({ message: "That is not an email address." }, 400);
      if (!body.orgId || !(await isMember(env.DB, body.orgId, session.github_id))) {
        return json({ message: "You are not a member of this organization." }, 403);
      }
      const minted = await createInvite(env, { orgId: body.orgId, createdBy: session.github_id, role: body.role, uses: 1, channels: body.channels });
      if (minted.error) return json({ message: minted.error }, 400);
      const sender = await getUserByGithubId(env.DB, session.github_id);
      const mail = composeInviteEmail({
        inviter: sender?.name || sender?.login || null,
        team: await teamName(env.DB, body.orgId),
        code: minted.code,
        url: minted.link,
        days: 7,
        locale: await loadCopy(env, sender?.locale || localeFromRequest(request) || "en", { orgId: body.orgId }),
      });
      const sent = await sendMail(env, { to, subject: mail.subject, text: mail.text });
      if (!sent.ok) {
        // A code nobody received is a door left open for nothing.
        await env.DB.prepare("DELETE FROM invites WHERE code = ?1").bind(minted.code).run();
        return json({ message: "We could not send the invitation. Try again in a moment." }, 502);
      }
      return json({ ok: true, ref: minted.ref, role: minted.role, to });
    }

    if (url.pathname === "/invites/accept" && request.method === "POST") {
      // Redeeming or minting a code grants org membership, so both are guessable
      // surfaces and both get the same budget as the other credential routes.
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401);
      const body = await request.json().catch(() => ({}));
      const result = await acceptInvite(env, { code: body.code || body.link, userId: session.github_id });
      if (result.error) return json({ message: result.error }, 400);
      return json(result);
    }

    // Start a team. The one workspace a sign-up hands out is enough for
    // one person; the second business, the side project, the client you
    // work with, each want a room of their own with a name on the door.
    if (url.pathname === "/orgs" && request.method === "POST") {
      const limited = await enforce(env, request, "team");
      if (limited) return limited;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401);
      const body = await request.json().catch(() => ({}));
      const result = await createTeam(env.DB, { name: body.name, createdBy: session.github_id });
      if (result.error) return json({ message: result.error }, 400);
      return json(result);
    }

    // Name, or rename, the team. Admins of it, and never a repository.
    // What this workspace runs its AI on. Everyone in it may read the
    // status; an admin may change it. Keys never come back out.
    if (url.pathname === "/orgs/ai" && (request.method === "GET" || request.method === "PUT")) {
      const limited = await enforce(env, request, "team");
      if (limited) return limited;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401);
      const body = request.method === "PUT" ? await request.json().catch(() => null) : null;
      if (request.method === "PUT" && (!body || typeof body !== "object")) return json({ message: "Invalid JSON body." }, 400);
      const orgId = request.method === "GET" ? url.searchParams.get("orgId") : body.orgId;
      if (!orgId || typeof orgId !== "string") return json({ message: "orgId is required" }, 400);
      if (!(await isMember(env.DB, orgId, session.github_id))) return json({ message: "not a member of this org" }, 403);
      const canEdit = await canRename(env.DB, orgId, session.github_id);
      if (request.method === "PUT") {
        if (!canEdit) return json({ message: "Only an admin of this workspace can change what its AI runs on." }, 403);
        const result = await saveAISettings(env.DB, orgId, {
          model: body.model, openaiKey: body.openaiKey, typesafeKey: body.typesafeKey,
        }, session.github_id);
        if (result.error) return json({ message: result.error }, 400);
      }
      return json({ orgId, canEdit, ...(await aiStatus(env, orgId)) });
    }
    // The workspace's mark. Anyone can see it (the id is unguessable, like a
    // card's video); its admins set and remove it.
    const iconMatch = url.pathname.match(/^\/orgs\/icon\/([^/]+)$/);
    if (iconMatch && request.method === "GET") {
      return serveOrgIcon(decodeURIComponent(iconMatch[1]), env);
    }
    if (url.pathname === "/orgs/icon" && (request.method === "POST" || request.method === "DELETE")) {
      const limited = await enforce(env, request, "team");
      if (limited) return limited;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401);
      const orgId = url.searchParams.get("orgId") || "";
      if (!orgId) return json({ message: "orgId is required" }, 400);
      if (!(await isMember(env.DB, orgId, session.github_id))) return json({ message: "not a member of this org" }, 403);
      if (!(await canRename(env.DB, orgId, session.github_id))) return json({ message: "Only an admin of this workspace can change its logo." }, 403);
      if (request.method === "DELETE") {
        await removeOrgIcon(env, orgId);
        return json({ orgId, icon: null });
      }
      const result = await uploadOrgIcon(request, env, orgId);
      if (result.error) return json({ message: result.error }, result.status || 400);
      return json({ orgId, icon: iconUrl(url.origin, result.mediaId) });
    }
    if (url.pathname === "/orgs/name" && request.method === "PUT") {
      const limited = await enforce(env, request, "team");
      if (limited) return limited;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401);
      const body = await request.json().catch(() => ({}));
      const result = await renameTeam(env.DB, { orgId: body.orgId, actorId: session.github_id, name: body.name });
      if (result.error) return json({ message: result.error }, result.status || 400);
      return json(result);
    }

    // Who is here, and what is still out. Both scoped to one org and both
    // requiring membership of it — the team is not public, and neither is the
    // list of ways into it.
    if (url.pathname === "/members" && request.method === "GET") {
      const limited = await enforce(env, request, "team");
      if (limited) return limited;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401);
      const orgId = url.searchParams.get("orgId");
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      return json({
        members: await listMembersForClient(env.DB, orgId, session.github_id),
        // Whether this list is ours to change. A repository-backed org's
        // members are its collaborators, so the screen shows them and says
        // where they are actually decided rather than offering a button that
        // the next org-graph load would undo.
        editable: membershipIsOurs(orgId),
        // What the team calls itself, and whether this person may change it.
        name: await teamName(env.DB, orgId),
        canRename: await canRename(env.DB, orgId, session.github_id),
        // And its mark, when it has one.
        icon: iconUrl(url.origin, (await getOrgIcon(env.DB, orgId))?.mediaId),
      });
    }

    if (url.pathname === "/members" && request.method === "DELETE") {
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401);
      const body = await request.json().catch(() => ({}));
      if (!body.orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, body.orgId);
      if (denied) return denied;
      const result = await removeMember(env, {
        orgId: body.orgId,
        actorId: session.github_id,
        // `ref` is what a client holds; `userId` is what the server itself
        // has, and the iOS build in the field still sends it.
        targetId: body.userId,
        ref: body.ref,
      });
      if (result.error) return json({ message: result.error }, result.status || 400);
      // Out of the table is not out of the room. A socket is authorized once,
      // at join, so the one they are already holding keeps receiving this
      // org's cards until something else drops it.
      await evictMember(env, body.orgId, result.login);
      return json(result);
    }

    if (url.pathname === "/invites" && request.method === "GET") {
      const limited = await enforce(env, request, "team");
      if (limited) return limited;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401);
      const orgId = url.searchParams.get("orgId");
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      return json({ invites: await listInvites(env, { orgId, viewerId: session.github_id }) });
    }

    if (url.pathname === "/invites" && request.method === "DELETE") {
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401);
      const body = await request.json().catch(() => ({}));
      if (!body.orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, body.orgId);
      if (denied) return denied;
      const result = await revokeInvite(env, {
        orgId: body.orgId,
        viewerId: session.github_id,
        code: body.code,
        ref: body.ref,
      });
      if (result.error) return json({ message: result.error }, result.status || 400);
      return json(result);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        githubOAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        githubOAuthWeb: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.GITHUB_WEB_REDIRECT_URI),
        aiRouting: Boolean(env.OPENAI_API_KEY || env.OPENROUTER_API_KEY),
        systemOne: Boolean(env.TYPESAFE_API_KEY),
        aiModel: env.OPENAI_API_KEY
          ? env.OPENAI_MODEL || "gpt-4o-mini"
          : env.OPENROUTER_API_KEY
            ? env.OPENROUTER_MODEL || "inclusionai/ling-3.0-flash:free"
            : "fallback",
        push: isConfigured(env),
        webPush: isWebPushConfigured(env),
        email: isMailConfigured(env),
        // Invite links and notification links need the web's own address.
        inviteLinks: Boolean(inviteLink(env, "probe")),
        // What still stands between a stranger and a working account. None
        // of this is secret: it is whether a thing is set, not what it is.
        // Mail from the shared Resend sender reaches only the Resend
        // account's own address, so until a domain is verified nobody else
        // can receive a sign-in code.
        mailSender: env.NOTIFY_EMAIL_FROM && !/resend\.dev/i.test(env.NOTIFY_EMAIL_FROM) ? "verified" : "shared",
        connectors: Boolean(env.COMPOSIO_API_KEY),
        billing: Boolean(env.REVENUECAT_SECRET_KEY),
        githubOAuthNative: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      });
    }
    if (url.pathname === "/agui/tools" && request.method === "GET") {
      return json(toolManifest());
    }
    if (url.pathname === "/ai/route" && request.method === "POST") {
      const limited = await enforce(env, request, "ai/route");
      if (limited) return limited;
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
      // The whole body becomes a prompt. An instruction is a sentence or a
      // paragraph; anything longer is not one, and on a paid, unmetered tier
      // it is somebody else's model context on our key.
      if (typeof body.text !== "string" || !body.text.trim()) {
        return json({ message: "text is required." }, 400);
      }
      if (body.text.length > MAX_INSTRUCTION_CHARS) {
        return json({ message: `That instruction is too long (over ${MAX_INSTRUCTION_CHARS} characters).` }, 400);
      }
      if (typeof body.senderContext === "string" && body.senderContext.length > MAX_INSTRUCTION_CHARS) {
        return json({ message: "senderContext is too long." }, 400);
      }
      const userKey = request.headers.get("x-ai-key") || undefined;
      // The route is usable without a session (guests), but only a session can
      // be metered — and an unmetered guest must not spend our AI budget.
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const allowance = await allowanceFor(env, body.organization?.orgId || body.orgId, {
        githubId: session ? String(session.github_id) : null,
        userKey,
      });

            // Build the org from real memberships when we can, so routing sees the
      // whole team (and cannot be spoofed by the client). Fall back to whatever
      // the client sent only when there is no session/org to look up.
      let organization = body.organization;
      let teamContext;
      let lookups;
      const routeOrgId = body.organization?.orgId || body.orgId;
      // A mention is a choice: "@Kenji, approve the price" is for Kenji.
      // One mention names the recipient outright; several leave it to the
      // router, which then sees the whole member list.
      const mentions = Array.isArray(body.mentions) ? body.mentions.filter((m) => typeof m === "string" && m.trim()).slice(0, 10) : [];
      if (mentions.length > 1) body.memberReferences = true;
      const chosenId = body.recipientUserID !== undefined
        ? body.recipientUserID
        : (mentions.length === 1 ? (mentions[0].startsWith("member:") ? mentions[0] : `member:${mentions[0]}`) : undefined);
      if (chosenId !== undefined && (typeof chosenId !== "string" || !chosenId.trim())) {
        return json({ message: "Choose a workspace member." }, 400);
      }
      if ((chosenId !== undefined || body.memberReferences === true) && (!session || !routeOrgId)) {
        return json({ message: "Sign in to a workspace before choosing a teammate." }, 401);
      }
      let routeMembers = [];
      let chosenMember;
      if (session && routeOrgId) {
        // Naming an org is not belonging to it. Everything else that reads an
        // organization checks this; this route did not, and it answers with a
        // recipient and an agent route built from that org's real membership
        // rows — so any signed-in account could name a team it had no part in
        // (a repository org is just "owner/repo") and be told, by name, who is
        // on it. The reply is small; the list it is drawn from is not public.
        //
        // Through authorizeOrgAccess rather than the membership table alone,
        // for the reason that function documents: the table is written when
        // somebody loads the org graph, so a GitHub account routing before it
        // has ever done so is a member GitHub knows about and this database
        // does not. Asking GitHub is what the socket does on join.
        const allowed = await authorizeOrgAccess(env, session, routeOrgId);
        if (!allowed.ok) return json({ message: "not a member of this org" }, 403);
        if (chosenId !== undefined || body.memberReferences === true) {
          routeMembers = await listMembers(env.DB, routeOrgId, session.github_id);
          if (chosenId !== undefined) {
            chosenMember = routeMembers.find(m => chosenId === `member:${m.ref}` || chosenId === m.login);
            if (!chosenMember) return json({ message: "That recipient is not a current member of this workspace." }, 400);
          }
        }
        const nodes = await listOrgNodes(env.DB, routeOrgId);
        if (nodes.length) {
          organization = { ...(body.organization || {}), orgId: routeOrgId, nodes };
        }
        // The org's businesses, so the router can file the card under one.
        // From the table, never the client: a slug the router returns must be
        // one the feed can filter by.
        const businesses = await listBusinesses(env.DB, routeOrgId, { viewer: session ? (await getUserByGithubId(env.DB, session.github_id))?.login || null : null });
        if (businesses.length) organization = { ...(organization || {}), orgId: routeOrgId, businesses };
        // What the team is carrying and what it decided lately. The router
        // used to see roles and nothing else — "their priorities and current
        // situation", which the product promises to weigh, were never in the
        // prompt. Two queries, both bounded, both optional: a failure here is
        // a card routed the old way, not a card not routed.
        try {
          const [load, recent, playbook] = await Promise.all([
            recipientLoad(env.DB, routeOrgId),
            recentDecisions(env.DB, routeOrgId),
            // The rules this team has set, the ones that bear on this
            // instruction first.
            relevantMemories(env.DB, routeOrgId, body.text),
          ]);
          if (load.length || recent.length || playbook.length) teamContext = { load, recent, playbook };
        } catch (err) {
          console.error("team context failed", err?.message || err);
        }
        // And the one thing the model may look up before it writes: what
        // this team already decided about the same thing.
        const lookupOrg = routeOrgId;
        lookups = { searchDecisions: (query) => searchDecisions(env.DB, lookupOrg, query) };
        // And the person's own connected tools, when they have them.
        try {
          const routeSession = await getSession(env.DB, request.headers.get("x-session-token"));
          const sources = await connectedSources(env, routeSession, lookupOrg);
          Object.assign(lookups, lookupsFor(env, routeSession, lookupOrg, sources));
        } catch (err) {
          console.error("connected sources failed", err?.message || err);
        }
      }

      if (chosenMember) {
        // The sender too, so the card names them as they go by here rather
        // than by a name made from their login.
        const self = routeMembers.find((m) => m.mine && m.login !== chosenMember.login);
        organization = { ...organization, nodes: [{ id: chosenMember.login, kind: "person",
          role: chosenMember.title || chosenMember.role, label: `${chosenMember.name} · ${chosenMember.title || chosenMember.role}` },
          ...(self ? [{ id: self.login, kind: "person", role: self.title || self.role, label: `${self.name} · ${self.title || self.role}` }] : [])], edges: [] };
      }
      // The sender's own "how I work", from the workspace's stored row when
      // the client did not carry it — a browser that never wrote one locally
      // still routes with what the phone saved.
      let senderContext = typeof body.senderContext === "string" ? body.senderContext : undefined;
      if (!senderContext && session && routeOrgId) {
        try {
          const user = await getUserByGithubId(env.DB, session.github_id);
          const stored = user ? (await loadContexts(env.DB, routeOrgId))[user.login] : undefined;
          if (typeof stored?.text === "string" && stored.text.trim()) senderContext = stored.text;
        } catch (err) {
          console.error("stored context failed", err?.message || err);
        }
      }
      const routeProvider = allowance.allowed ? await providerFor(env, routeOrgId, userKey) : undefined;
      // The router's own words on the card ("Approval needed") when it has no
      // model to write them, in the reader's language.
      if (typeof body.readerLanguage === "string") await loadCopy(env, body.readerLanguage, { orgId: routeOrgId });
      const result = await routeInstruction({
        text: body.text,
        sender: body.sender,
        organization,
        priorityOverride: body.priorityOverride,
        readerLanguage: body.readerLanguage,
        senderContext,
        teamContext,
        lookups,
        // No provider means the local keyword router — the graceful degradation.
        openRouter: routeProvider,
        // System One decides for a fraction of a cent, allowance or not; the
        // language model is the second opinion, within the allowance. But
        // only for someone signed in: a guest is unmetered, and unmetered
        // must mean spending nothing, however little.
        systemOne: session ? await jevFor(env, routeOrgId) : undefined,
      });
      if (chosenMember) {
        result.recipientUserID = chosenMember.login;
        result.routingReason = serverText(typeof body.readerLanguage === "string" ? body.readerLanguage : "en", "route.selectedByYou");
        // The name this person goes by here, not the one a client made up
        // from the login.
        const me = routeMembers.find((m) => m.mine);
        result.agentRoute = `${me?.name || body.sender?.name || "You"} → ${chosenMember.name}`;
      }
      if (body.memberReferences === true) {
        const recipient = routeMembers.find(m => m.login === result.recipientUserID);
        if (!recipient) return json({ message: "Choose a current workspace member." }, 400);
        result.recipientUserID = recipient.mine ? recipient.login : `member:${recipient.ref}`;
      }
      // Only a model that actually answered is billable — including one whose
      // answer we then rejected, which still comes back as routedBy "fallback".
      // A provider outage never burns someone's three.
      const modelAnswered = allowance.allowed && result.aiCalled === true;
      if (modelAnswered && allowance.metered) await allowance.consume();
      // The bill, by team: the model's tokens and System One's, whoever paid.
      if (session && routeOrgId) {
        await settleUsage(env.DB, routeProvider, { orgId: routeOrgId, githubId: session.github_id, byok: Boolean(userKey) },
          result.systemOneUsage ? [jevEntry("route", result.systemOneUsage)] : []);
      }
      // Internal to the meter. Stripped so the wire format is unchanged.
      delete result.aiCalled;
      delete result.systemOneUsage;

      return json(allowance.quotaExceeded ? { ...result, quotaExceeded: true } : result);
    }
    if (url.pathname === "/oauth/github/config" && request.method === "GET") {
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return json({ message: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET as Worker secrets" }, 503);
      }
      // The app comes back through its own URL scheme; the web through a page
      // on its own origin. Each is a callback URL registered on the GitHub
      // OAuth app, and the web one is offered only where it has been set.
      if (url.searchParams.get("client") === "web") {
        if (!env.GITHUB_WEB_REDIRECT_URI) {
          return json({ message: "GitHub sign-in on the web is not set up on this deployment (GITHUB_WEB_REDIRECT_URI)." }, 503);
        }
        return json({ clientId: env.GITHUB_CLIENT_ID, redirectUri: env.GITHUB_WEB_REDIRECT_URI, scope: env.GITHUB_OAUTH_SCOPE || "repo" });
      }
      return json({
        clientId: env.GITHUB_CLIENT_ID,
        redirectUri: env.GITHUB_REDIRECT_URI || "tiktokforwork://oauth/callback",
        scope: env.GITHUB_OAUTH_SCOPE || "repo",
      });
    }
    // Minted here, spent on the callback. The client puts it on the authorize
    // URL as `state` and refuses a callback that comes back with a different
    // one; we refuse a code that arrives without a nonce we issued.
    if (url.pathname === "/oauth/github/state" && request.method === "GET") {
      const limited = await enforce(env, request, "oauth/state");
      if (limited) return limited;
      return json({ state: await createOAuthState(env.DB) });
    }
    if (url.pathname === "/oauth/github/token" && request.method === "POST") {
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const { code, state, redirectUri } = await request.json().catch(() => ({}));
      // The redirect the code was issued for. GitHub checks it against the
      // authorize step, and we check it against the two we registered, so a
      // caller cannot exchange a code through an address of their own.
      const appRedirect = env.GITHUB_REDIRECT_URI || "tiktokforwork://oauth/callback";
      const allowedRedirects = new Set([appRedirect, env.GITHUB_WEB_REDIRECT_URI].filter(Boolean));
      const redirect = typeof redirectUri === "string" && redirectUri ? redirectUri : appRedirect;
      if (!allowedRedirects.has(redirect)) return json({ message: "That is not a sign-in address this deployment knows." }, 400);
      if (!(await consumeOAuthState(env.DB, state))) {
        return json({ message: "This sign-in has expired. Try again." }, 400);
      }
      const ghRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirect,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await ghRes.json();
      if (!data.access_token) {
        return json({ message: data.error_description || "token exchange failed" }, 400);
      }
      const userRes = await fetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${data.access_token}`, "user-agent": "tiktokforwork" },
        signal: AbortSignal.timeout(20_000),
      });
      const ghUser = await userRes.json();
      if (!ghUser?.id) return json({ message: "GitHub did not identify this token" }, 502);
      // The user row used to appear only when someone loaded the org graph,
      // which happens after the socket connects — so the relay could not name
      // the person who had just signed in. Identity is established here, where
      // it is first known.
      // Seeded from the device's language on first sign-in only: upsertUser
      // keeps a stored locale when none is passed, and an explicit choice made
      // through PUT /me is the only thing that changes it after that.
      const existing = await getUserByGithubId(env.DB, ghUser.id);
      await upsertUser(env.DB, {
        githubId: ghUser.id, login: ghUser.login, name: ghUser.name,
        avatarUrl: ghUser.avatar_url, locale: existing ? undefined : localeFromRequest(request),
      });
      const sessionToken = await createSession(env.DB, String(ghUser.id), data.access_token);
      // The GitHub token is not handed back. It carries `repo` scope — every
      // repository this person can reach, code included — and the app does six
      // things with it, all of which now go through /github. A session cannot
      // be replayed against api.github.com; an access token can.
      // The workspaces this account already belongs to, so a returning person
      // lands in one instead of the repository picker.
      const orgs = (await listUserOrgs(env.DB, String(ghUser.id)).catch(() => [])).map((o) => o?.id).filter(Boolean);
      return json({ tokenType: "bearer", sessionToken, login: ghUser.login, orgs });
    }
    if (url.pathname === "/media" && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const limited = await enforce(env, request, "media");
      if (limited) return limited;
      return uploadMedia(request, env, url);
    }
    const mediaMatch = url.pathname.match(/^\/media\/([^/]+)$/);
    if (mediaMatch && request.method === "GET") {
      return serveMedia(mediaMatch[1], env);
    }
    // The businesses an organization runs. Read by the feed for its filter
    // chips and by the router for its enum; written when someone names a new
    // one — from here, or by tagging a card with a name nobody has typed
    // before. `orgId` is a query or body field rather than a path segment
    // because a personal org id is not "owner/repo".
    // The room is told only the public channels, and whether there are
    // private ones — a member of one asks again for their own list.
    const tellRoom = async (orgId) => announceEvents(env, orgId, [customEvent("businesses", {
      businesses: await listBusinesses(env.DB, orgId), partial: await hasPrivateBusinesses(env.DB, orgId),
    })]);
    const viewerLogin = async () => {
      const s = await getSession(env.DB, request.headers.get("x-session-token"));
      return s ? (await getUserByGithubId(env.DB, s.github_id))?.login || null : null;
    };
    if (url.pathname === "/businesses" && request.method === "GET") {
      const orgId = url.searchParams.get("orgId");
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      return json({ businesses: await listBusinesses(env.DB, orgId, { viewer: await viewerLogin() }) });
    }
    if (url.pathname === "/businesses" && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = await request.json().catch(() => ({}));
      if (!body.orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, body.orgId);
      if (denied) return denied;
      if (!businessSlug(body.name)) return json({ message: "A business needs a name." }, 400);
      const me = await getUserByGithubId(env.DB, session.github_id);
      if (body.private === true) {
        // A private channel is made, never found: a name already taken —
        // public or private, seen or not — is somebody else's channel.
        const slug = businessSlug(body.name);
        if (await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(body.orgId, slug).first()) {
          return json({ message: "A channel by that name already exists." }, 409);
        }
        const business = await upsertBusiness(env.DB, body.orgId, { name: body.name, createdBy: String(session.github_id) });
        await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = ?2").bind(body.orgId, business.slug).run();
        const members = await listMembers(env.DB, body.orgId, session.github_id);
        const refs = Array.isArray(body.members) ? body.members.map(String) : [];
        const logins = [me.login, ...members.filter((m) => refs.includes(m.ref)).map((m) => m.login)];
        await addMembers(env.DB, { orgId: body.orgId, key: `b:${business.slug}`, logins, addedBy: me.login });
        await tellMembers(env, body.orgId, logins);
        await tellRoom(body.orgId);
        return json({ business: { ...business, private: true }, businesses: await listBusinesses(env.DB, body.orgId, { viewer: me.login }) });
      }
      const business = await upsertBusiness(env.DB, body.orgId, { name: body.name, createdBy: String(session.github_id) });
      // Everyone with the workspace open sees the new channel now.
      await tellRoom(body.orgId);
      return json({ business, businesses: await listBusinesses(env.DB, body.orgId, { viewer: me?.login || null }) });
    }
    // A channel's new name. Any member: a channel is the team's, like a
    // card is.
    if (url.pathname === "/businesses" && request.method === "PUT") {
      const body = await request.json().catch(() => ({}));
      if (!body.orgId || !body.slug) return json({ message: "orgId and slug are required" }, 400);
      const denied = await requireMember(env, request, body.orgId);
      if (denied) return denied;
      const who = await viewerLogin();
      // A private channel is its members' to rename; to anybody else it is
      // not there.
      if (!(await canTouchChannel(env.DB, body.orgId, String(body.slug), who))) return json({ message: "A channel needs a name, and this one must exist." }, 400);
      const renamed = await renameBusiness(env.DB, body.orgId, String(body.slug), body.name);
      if (!renamed) return json({ message: "A channel needs a name, and this one must exist." }, 400);
      await tellRoom(body.orgId);
      return json({ business: renamed, businesses: await listBusinesses(env.DB, body.orgId, { viewer: who }) });
    }
    if (url.pathname === "/businesses" && request.method === "DELETE") {
      const body = await request.json().catch(() => ({}));
      if (!body.orgId || !body.slug) return json({ message: "orgId and slug are required" }, 400);
      const denied = await requireMember(env, request, body.orgId);
      if (denied) return denied;
      const who = await viewerLogin();
      if (!(await canTouchChannel(env.DB, body.orgId, String(body.slug), who))) return json({ businesses: await listBusinesses(env.DB, body.orgId, { viewer: who }), unfiled: 0 });
      const wasPrivate = await isPrivate(env.DB, body.orgId, String(body.slug));
      const insiders = wasPrivate ? await membersOf(env.DB, body.orgId, `b:${body.slug}`) : [];
      // Deleting a channel empties it: its cards are unfiled (the decisions
      // themselves stay), so nothing keeps the channel alive in a list.
      // Filing a card under the name again brings the channel back.
      await removeBusiness(env.DB, body.orgId, body.slug);
      await env.DB.prepare("DELETE FROM conversation_members WHERE org_id = ?1 AND channel = ?2").bind(body.orgId, `b:${body.slug}`).run();
      const unfiled = await unfileBusiness(env.DB, body.orgId, String(body.slug));
      await tellRoom(body.orgId);
      if (wasPrivate) await tellMembers(env, body.orgId, insiders);
      if (unfiled.length) await announceCards(env, body.orgId, unfiled, { isNew: false });
      return json({ businesses: await listBusinesses(env.DB, body.orgId, { viewer: who }), unfiled: unfiled.length });
    }

    // The record: every decision, per business, as it stands right now.
    // JSON for the client, Markdown (?format=md) for pasting anywhere else.
    if (url.pathname === "/record" && request.method === "GET") {
      const orgId = url.searchParams.get("orgId");
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const me = await getUserByGithubId(env.DB, session.github_id);
      const locale = normalizeLocale(url.searchParams.get("locale")) || me?.locale || "en";
      const record = await buildRecord(env.DB, orgId, { locale, viewer: me?.login || null });
      if (url.searchParams.get("format") === "md") {
        return new Response(recordToMarkdown(record, locale), {
          headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" },
        });
      }
      return json(record);
    }

    // What this account can spend, and what there is to buy. Read by the
    // plan screen; also what tells the feed how many free routes are left.
    if (url.pathname === "/billing/redeem" && request.method === "POST") {
      const headers = { "cache-control": "no-store" };
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "Please sign in." }, 401, headers);
      const retryAfter = await limitRedemption(env, request, session.github_id);
      if (retryAfter) return json({ message: "Too many attempts. Try again shortly." }, 429,
        { ...headers, "retry-after": String(retryAfter) });
      if (!complimentaryAvailable(env)) return json({ message: "Code redemption is unavailable right now." }, 503, headers);
      const code = await readRedemptionCode(request);
      if (!(await redeemComplimentaryAccess(env, session.github_id, code))) {
        return json({ message: "This code is not valid." }, 400, headers);
      }
      const status = await billingStatus(env, session.github_id);
      if (status.complimentarySyncPending) {
        return json({ ...status, message: "Free access is saved. iOS activation is pending; refresh your plan to retry." }, 503, headers);
      }
      return json(status, 200, headers);
    }

    if (url.pathname === "/billing/status" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const orgId = url.searchParams.get("orgId") || "";
      if (orgId && !(await isMember(env.DB, orgId, session.github_id))) return json({ message: "not a member of this org" }, 403);
      return json(await billingStatus(env, session.github_id, orgId || undefined), 200, { "cache-control": "no-store" });
    }

    // Who am I, and how do I want to be told. The locale here is the language
    // every notification to this person is written in, whichever channel
    // carries it — set explicitly by the app's language toggle or the browser,
    // seeded from Accept-Language on the first sign-in.
    if (url.pathname === "/me" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const user = await getUserByGithubId(env.DB, session.github_id);
      if (!user) return json({ message: "unknown user" }, 409);
      const lang = await loadCopy(env, user.locale || "en");
      return json({
        login: user.login,
        userId: user.github_id,
        orgId: await primaryOrgId(env.DB, session.github_id),
        name: user.name,
        handle: user.handle || null,
        avatarUrl: user.avatar_url || null,
        locale: user.locale || "en",
        email: user.email || null,
        // An email account signs in with its address; only a GitHub account
        // can change where mail goes.
        emailEditable: !String(user.github_id).startsWith("email:"),
        aliases: parseAliases(user.aliases),
        notifyEmail: Number(user.notify_email ?? 1) !== 0,
        supportedLocales: SUPPORTED_LOCALES,
        // The words of the notification a browser tab shows by itself, in
        // this person's language — which the page's own tables may not have.
        notificationCopy: {
          locale: lang,
          newDecision: t(lang, "tabNewDecision"),
          from: t(lang, "tabFrom", { name: "{name}" }),
        },
        // What the router will assume you decide, and what you may change it
        // to. This is the description, not the standing: an admin who says
        // they are a designer is still an admin.
        role: url.searchParams.get("orgId")
          ? await ownTitle(env.DB, url.searchParams.get("orgId"), session.github_id)
          : null,
        assignableRoles: SELF_ASSIGNABLE_ROLES,
        // Where this person works. Without it a client that has lost its
        // stored orgId — a second browser, a cleared cache, a sign-in on a
        // borrowed laptop — had nothing to ask and fell back to a placeholder
        // nobody is a member of, so the relay refused the socket and the feed
        // never arrived.
        orgs: await (async () => {
          const orgs = await listUserOrgs(env.DB, session.github_id);
          const icons = await iconsFor(env.DB, orgs.map((o) => o.id));
          return orgs.map((o) => ({ ...o, icon: iconUrl(url.origin, icons[o.id]) }));
        })(),
      });
    }
    // How this person works, as the router should know it — stored per
    // person, per workspace, on the server. The same row the app's relay
    // writes (`context_updated`), so a phone and a browser see one answer.
    // Nothing here crosses a workspace: the row is read by (org, login) and
    // only for an org the caller belongs to.
    if (url.pathname === "/me/context" && (request.method === "GET" || request.method === "PUT")) {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = request.method === "PUT" ? await request.json().catch(() => null) : null;
      if (request.method === "PUT" && (!body || typeof body !== "object")) {
        return json({ message: "Invalid JSON body." }, 400);
      }
      const orgId = request.method === "GET" ? url.searchParams.get("orgId") : body.orgId;
      if (!orgId || typeof orgId !== "string" || !orgId.trim()) return json({ message: "orgId is required" }, 400);
      if (!(await isMember(env.DB, orgId, session.github_id))) {
        return json({ message: "not a member of this org" }, 403);
      }
      const user = await getUserByGithubId(env.DB, session.github_id);
      if (!user) return json({ message: "unknown user" }, 409);
      if (request.method === "PUT") {
        if (typeof body.text !== "string") return json({ message: "text must be a string" }, 400);
        if (body.text.length > MAX_INSTRUCTION_CHARS) return json({ message: "That context is too long." }, 400);
        const existing = await loadContexts(env.DB, orgId);
        const isNew = !(user.login in existing);
        const context = { ...(existing[user.login] || {}), text: body.text };
        await saveContext(env.DB, orgId, user.login, context);
        // Tell the workspace's open sockets, as the relay would have.
        await announceEvents(env, orgId, contextEvents(user.login, context, { isNew }));
        return json({ orgId, text: body.text });
      }
      const contexts = await loadContexts(env.DB, orgId);
      const mine = contexts[user.login];
      return json({ orgId, text: typeof mine?.text === "string" ? mine.text : "" });
    }
    if (url.pathname === "/me" && request.method === "PUT") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = await request.json().catch(() => ({}));
      if (body.locale !== undefined) {
        if (!normalizeLocale(body.locale)) return json({ message: "locale must be a language tag like en or ja-JP" }, 400);
        await setUserLocale(env.DB, session.github_id, body.locale);
      }
      if (body.notifyEmail !== undefined) {
        await setUserNotifyEmail(env.DB, session.github_id, Boolean(body.notifyEmail));
      }
      // What you are called, and the username @ finds you by.
      if (body.name !== undefined) {
        const name = cleanName(body.name);
        if (!name) return json({ message: `A name is 1 to ${MAX_NAME_CHARS} characters.` }, 400);
        await setUserName(env.DB, session.github_id, name);
      }
      if (body.handle !== undefined) {
        const checked = checkHandle(body.handle);
        if (checked.error) return json({ message: checked.error, field: "handle" }, 400);
        const taken = await setUserHandle(env.DB, session.github_id, checked.handle);
        if (taken.error) return json({ message: taken.error, field: "handle" }, 409);
      }
      if (body.aliases !== undefined) {
        const aliases = normalizeAliases(body.aliases);
        if (!aliases) return json({ message: "aliases must be a list of names" }, 400);
        await setUserAliases(env.DB, session.github_id, aliases);
      }
      // Where email falls back to. A GitHub account has none unless it says
      // so here; an email account's address is its login and cannot change.
      if (body.email !== undefined) {
        const result = await setUserEmail(env.DB, session.github_id, body.email);
        if (result.error) return json({ message: result.error }, 400);
      }
      // What you do, as the router understands it. Scoped to one org because
      // that is where it lives, and it changes no standing — see setOwnTitle.
      let role;
      if (body.role !== undefined) {
        if (!body.orgId) return json({ message: "orgId is required to set a role" }, 400);
        const result = await setOwnTitle(env.DB, body.orgId, session.github_id, body.role);
        if (result.error) return json({ message: result.error }, 400);
        role = result.role;
      }
      const user = await getUserByGithubId(env.DB, session.github_id);
      return json({
        ok: true,
        locale: user?.locale || "en",
        email: user?.email || null,
        notifyEmail: Number(user?.notify_email ?? 1) !== 0,
        aliases: parseAliases(user?.aliases),
        name: user?.name || null,
        handle: user?.handle || null,
        ...(role ? { role } : {}),
      });
    }

    // Web Push. The public key is what a browser subscribes with; the
    // subscription it gets back is posted here, bound to the person on the
    // session — never to a login the browser claims.
    if (url.pathname === "/push/vapid" && request.method === "GET") {
      if (!isWebPushConfigured(env)) return json({ message: "Web push is not configured on this deployment." }, 503);
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }
    if (url.pathname === "/push/subscriptions" && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = await request.json().catch(() => ({}));
      const subscription = parseSubscription(body);
      if (!subscription) return json({ message: "A push subscription with endpoint and keys is required." }, 400);
      const user = await getUserByGithubId(env.DB, session.github_id);
      if (!user?.login) return json({ message: "unknown user" }, 409);
      await registerSubscription(env.DB, {
        ...subscription,
        githubId: session.github_id,
        login: user.login,
        userAgent: (request.headers.get("user-agent") || "").slice(0, 200),
      });
      return json({ ok: true });
    }
    if (url.pathname === "/push/subscriptions" && request.method === "DELETE") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = await request.json().catch(() => ({}));
      // Yours, not anyone's. The endpoint is high-entropy, but the query was
      // keyed on it alone, so a signed-in account that learned another's could
      // unsubscribe them.
      if (typeof body.endpoint === "string") await removeSubscription(env.DB, body.endpoint, session.github_id);
      return json({ ok: true });
    }
    // Registered after the user grants permission, and re-registered on every
    // launch — APNs reissues tokens, and a stale one is a silent no-op.
    if (url.pathname === "/devices" && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = await request.json().catch(() => ({}));
      if (!body.deviceToken) return json({ message: "deviceToken is required" }, 400);
      // Shape-checked here rather than trusted: this string ends up in the path
      // of a request to Apple, signed with our provider token.
      if (!isDeviceToken(body.deviceToken)) {
        return json({ message: "That is not an APNs device token." }, 400);
      }
      const user = await getUserByGithubId(env.DB, session.github_id);
      if (!user?.login) return json({ message: "unknown user" }, 409);
      await registerDevice(env.DB, {
        deviceToken: body.deviceToken,
        githubId: session.github_id,
        login: user.login,
        environment: body.environment,
      });
      return json({ ok: true });
    }
    if (url.pathname === "/devices" && request.method === "DELETE") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = await request.json().catch(() => ({}));
      if (typeof body.deviceToken === "string") await removeDevice(env.DB, body.deviceToken, session.github_id);
      return json({ ok: true });
    }
    // Everything we hold about the caller, as a download. Deletion without
    // export is half of what a person is owed — GDPR/APPI portability is the
    // other half.
    if (url.pathname === "/account/export" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const user = await getUserByGithubId(env.DB, session.github_id);
      const data = await exportAccount(env.DB, session.github_id, user?.login || null);
      return new Response(JSON.stringify(data, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="honmaru-export-${new Date().toISOString().slice(0, 10)}.json"`,
        },
      });
    }
    if (url.pathname === "/account" && request.method === "DELETE") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const user = await getUserByGithubId(env.DB, session.github_id);
      // Where they were, before the rows saying so are deleted. A socket is
      // authorized once, at join, so a deleted account's open connection would
      // otherwise go on receiving its old team's cards.
      const wasIn = await listUserOrgs(env.DB, session.github_id);
      if (!(await prepareComplimentaryDeletion(env, session.github_id))) {
        return json({ message: "Account deletion could not finish. Please try again shortly." }, 503,
          { "cache-control": "no-store" });
      }
      await deleteAccount(env.DB, session.github_id, user?.login || null);
      for (const org of wasIn) await evictMember(env, org.id, user?.login || null);
      return json({ ok: true });
    }
    const orgGraphMatch = url.pathname.match(/^\/orgs\/([^/]+)\/([^/]+)\/graph$/);
    if (orgGraphMatch && request.method === "GET") {
      const [, owner, repo] = orgGraphMatch;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const orgId = `${owner}/${repo}`;
      // An email account has no GitHub token, so this call would return a 401
      // and we would hand back GitHub's wording for a problem that is ours to
      // explain. The limitation is real — a repo-backed org's membership comes
      // from GitHub — so say that, at the point where we still know why.
      if (!isGitHubSession(session)) {
        return json({
          message: "This organization's members come from a GitHub repository. Sign in with GitHub to view them.",
        }, 400);
      }
      let collaborators;
      try {
        collaborators = await fetchCollaborators(session.github_access_token, owner, repo);
      } catch (err) {
        return json({ message: err.message }, 502);
      }
      const graph = buildOrgGraph(collaborators, { owner, repo });
      for (const c of collaborators) {
        // No locale: the graph knows who is on the team, not what they read.
        await upsertUser(env.DB, { githubId: c.id, login: c.login, name: c.login, avatarUrl: c.avatar_url });
        await upsertMembership(env.DB, orgId, c.id, roleName(c.permissions));
        await upsertAgent(env.DB, orgId, c.id, `${c.login}'s AI`);
      }
      // GitHub has just told us who the collaborators are. Anyone in the table
      // who is not on that list is not one any more — and until this line, that
      // never became false anywhere: the relay trusts this table, so being
      // removed from the repository did not remove you from the organization.
      // This is the moment we have the authoritative answer, so it is the
      // moment to act on it.
      const pruned = await retainMemberships(env.DB, orgId, collaborators.map((c) => c.id));
      // And out of the room, not only out of the table. A socket is authorized
      // once, at join, so somebody removed from the repository kept receiving
      // this org's cards on the connection they already had — the table said
      // they were gone and the open socket never asked it again.
      for (const login of pruned.logins) {
        await evictMember(env, orgId, login);
        // Their pending decisions go back to whoever asked for them. GitHub
        // removing somebody orphans a card exactly the way leaving does.
        await returnOrphanedCards(env, orgId, login);
      }
      return json(graph);
    }
    const cardEventsMatch = url.pathname.match(/^\/orgs\/([^/]+)\/([^/]+)\/cards\/([^/]+)\/events$/);
    if (cardEventsMatch && request.method === "GET") {
      const [, owner, repo, cardId] = cardEventsMatch;
      const orgId = `${owner}/${repo}`;
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      return json({ events: await withActorNames(env.DB, await listCardEvents(env.DB, orgId, cardId)) });
    }
    if (url.pathname === "/connectors" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);

      let accounts = [];
      try {
        accounts = await listConnectedAccounts(env.COMPOSIO_API_KEY, String(session.github_id));
      } catch (err) {
        return json({ message: err.message }, 502);
      }
      const active = new Set(
        accounts
          .filter((a) => String(a.status).toUpperCase() === "ACTIVE")
          .map((a) => (typeof a.toolkit === "string" ? a.toolkit : a.toolkit?.slug))
      );
      // What this person has connected, remembered, so the cron syncs them
      // between visits. Both clients load this list on the Tools screen.
      try {
        await rememberConnections(env.DB, session.github_id, availableConnectors(env).map((c) => c.id), active);
      } catch (err) {
        console.error("remembering connections failed", err?.message || err);
      }
      // Where this person's pulls land. Each person's tools are their own,
      // and so is the workspace they feed — named, so the screen can say so.
      const kept = await pullWorkspaceOf(env.DB, session.github_id);
      const pullOrg = kept && (await isMember(env.DB, kept, session.github_id)) ? kept : await primaryOrgId(env.DB, session.github_id);
      return json({
        connectors: availableConnectors(env).map((c) => ({
          id: c.id, label: c.label, status: active.has(c.id) ? "active" : "none",
        })),
        pullsInto: pullOrg ? { orgId: pullOrg, name: await teamName(env.DB, pullOrg).catch(() => null) } : null,
      });
    }

    // Whether the GitHub sync this deployment advertises can actually run here.
    //
    // The Tools screen listed it as "Always on · Built in" for everybody, and
    // for most people it is neither: syncing a decision to an Issue needs a
    // repository to put it in and a GitHub token to write with, and an email
    // account in the `personal:` workspace it was given at sign-up has
    // neither. Saying so is the whole of this route — it is separate from
    // GET /connectors because that one refuses outright without a Composio
    // key, and this answer does not depend on Composio at all.
    // Connect your GitHub: the same journey as Gmail or Slack — a page
    // opens, GitHub asks, you say yes — hosted by Composio.
    if (url.pathname === "/connectors/github/connect" && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);
      try {
        const link = await githubConnectLink(env, session.github_id);
        if (link.error) return json({ message: link.error }, 503);
        return json(link);
      } catch (err) {
        return json({ message: err.message }, 502);
      }
    }
    // The repositories your connected GitHub can write to — to pick one for
    // the workspace.
    if (url.pathname === "/connectors/github/repos" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);
      if (!(await myGithubAccount(env, session.github_id))) return json({ message: "Connect your GitHub first." }, 409);
      try {
        return json({ repos: await listMyRepositories(env, session.github_id) });
      } catch (err) {
        return json({ message: err.message }, 502);
      }
    }

    // GitHub, for any workspace. A repository workspace syncs as the person's
    // own account from the phone (`builtIn`); any workspace can name a
    // repository and hold a token, and then the Worker writes the issues.
    if (url.pathname === "/connectors/github" && (request.method === "GET" || request.method === "PUT" || request.method === "DELETE")) {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = request.method === "GET" ? null : await request.json().catch(() => ({}));
      const orgId = request.method === "GET" ? (url.searchParams.get("orgId") || "") : String(body?.orgId || "");
      if (!orgId) return json({ message: "orgId is required" }, 400);
      if (!(await isMember(env.DB, orgId, session.github_id))) return json({ message: "not a member of this org" }, 403);
      const isAdmin = await canRename(env.DB, orgId, session.github_id) || orgId.includes("/");
      // Connecting with your own GitHub is yours to do as a member — it is
      // your credential, and the issues are written as you. A pasted token
      // and a disconnect are the workspace's, so an admin's (or the person
      // who connected it).
      const canEdit = isAdmin || Boolean(env.COMPOSIO_API_KEY) || isGitHubSession(session);
      if (request.method !== "GET") {
        if (!canEdit) return json({ message: "Only an admin of this workspace can connect its repository." }, 403);
        if (request.method === "DELETE") {
          const current = await getWorkspaceGitHub(env.DB, orgId);
          if (!isAdmin && current && String(current.connectedBy) !== String(session.github_id)) {
            return json({ message: "Only an admin, or whoever connected it, can disconnect this repository." }, 403);
          }
          await disconnectWorkspaceGitHub(env.DB, orgId);
        } else {
          // A token they entered; else their GitHub connected through the
          // OAuth journey; else a GitHub sign-in's own token.
          const token = typeof body.token === "string" && body.token.trim()
            ? body.token.trim()
            : null;
          let result;
          if (token) {
            if (!isAdmin) return json({ message: "Only an admin of this workspace can connect it with a token." }, 403);
            result = await connectWorkspaceGitHub(env, { orgId, repo: String(body.repo || "").trim(), token, byGithubId: session.github_id });
          } else if (env.COMPOSIO_API_KEY && (await myGithubAccount(env, session.github_id))) {
            result = await connectWorkspaceGitHubAs(env, { orgId, repo: String(body.repo || "").trim(), githubId: session.github_id });
          } else if (isGitHubSession(session)) {
            result = await connectWorkspaceGitHub(env, { orgId, repo: String(body.repo || "").trim(), token: session.github_access_token, byGithubId: session.github_id });
          } else {
            return json({ message: "Connect your GitHub first, or enter a token." }, 400);
          }
          if (result.error) return json({ message: result.error }, 400);
        }
      }
      return json(await githubStatus(env, { session, orgId, canEdit, isGitHubSession: isGitHubSession(session) }));
    }

    const connectMatch = url.pathname.match(/^\/connectors\/([^/]+)\/connect$/);
    if (connectMatch && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);

      const connector = connectorById(connectMatch[1]);
      if (!connector) return json({ message: "unknown connector" }, 404);
      const authConfig = authConfigFor(env, connector);
      // Nothing to send them to. Said plainly rather than passing a null to
      // Composio, which answers with something about a malformed request.
      if (!authConfig) {
        return json({ message: `${connector.label} is not set up on this deployment yet.` }, 503);
      }

      try {
        const link = await createConnectLink(
          env.COMPOSIO_API_KEY, String(session.github_id), authConfig
        );
        return json({ redirectUrl: link.redirect_url, connectedAccountId: link.connected_account_id });
      } catch (err) {
        return json({ message: err.message }, 502);
      }
    }

    if (url.pathname === "/connectors/notion/databases" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);
      try {
        // filter_property:"object" + filter_value:"database" is what the live
        // API needs to return only databases; a bare filter_value lets pages
        // through (README, Notion verified 2026-08-10).
        const payload = await executeTool(
          env.COMPOSIO_API_KEY, "NOTION_SEARCH_NOTION_PAGE",
          String(session.github_id),
          { query: "", filter_value: "database", filter_property: "object" }
        );
        const rows = payload?.data?.results ?? payload?.data?.databases ?? [];
        const databases = rows.map((d) => ({
          id: d.id,
          // A database title is a rich-text array, never a plain string.
          title: Array.isArray(d.title)
            ? d.title.map((t) => t.plain_text || "").join("").trim() || "Untitled"
            : (d.title || "Untitled"),
        }));
        return json({ databases });
      } catch (err) {
        return json({ message: err.message }, 502);
      }
    }

    if (url.pathname === "/connectors/notion/config" && request.method === "PUT") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = await request.json().catch(() => ({}));
      if (typeof body.databaseId !== "string" || !body.databaseId) return json({ message: "databaseId is required" }, 400);
      // Beside what the connector already remembers (that it is connected),
      // not instead of it: this used to drop the `connected` flag, and the
      // person disappeared from the cron until the next time they opened Tools.
      const existing = await getConnectorConfig(env.DB, session.github_id, "notion");
      await setConnectorConfig(env.DB, session.github_id, "notion", { ...(existing || {}), databaseId: body.databaseId });
      return json({ ok: true });
    }

    if (url.pathname === "/connectors/notion/config" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      // Chosen-nothing is a normal state, not a 404: the app persists locally but
      // must be able to recover the server's truth on a fresh install or a second
      // device. Always return the same key the PUT accepts, null when unset, so
      // the client reads one field and never special-cases a status code.
      const config = await getConnectorConfig(env.DB, session.github_id, "notion");
      return json({ databaseId: config?.databaseId ?? null });
    }

    const syncMatch = url.pathname === "/connectors/sync"
      || url.pathname.match(/^\/connectors\/([^/]+)\/sync$/);
    if (syncMatch && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);
      const limited = await enforce(env, request, "connectors/sync");
      if (limited) return limited;

      const body = await request.json().catch(() => ({}));
      if (!body.orgId) return json({ message: "orgId is required" }, 400);

      // Membership is checked here for the same reason the relay checks it on
      // join: this route writes cards into an organization. Without it, any
      // valid session could name any org — and the recipient login came
      // straight off the request body, so it could name any person too. That
      // is card injection into a team you do not belong to, over plain HTTP,
      // around the whole trust boundary the socket enforces.
      const denied = await requireMember(env, request, body.orgId);
      if (denied) return denied;

      // Whose cards these are is decided by the session, never by the caller.
      // `body.userId` is still read by older builds' payloads; it is ignored.
      const me = await getUserByGithubId(env.DB, session.github_id);
      if (!me?.login) return json({ message: "unknown user" }, 409);
      // Where this person's own tools land from now on, the scheduled pull
      // included: the workspace they pulled from, not one guessed for them.
      await rememberPullWorkspace(env.DB, session.github_id, body.orgId);

      // A single-connector path keeps TestFlight build 28 working; it shipped
      // calling /connectors/gmail/sync and returns the flat shape.
      const only = typeof syncMatch === "object" ? connectorById(syncMatch[1]) : null;
      if (typeof syncMatch === "object" && !only) return json({ message: "unknown connector" }, 404);

      const startedAt = new Date().toISOString();
      const syncProvider = await providerFor(env, body.orgId);
      // Only the tools this person connected. The list of what they hold is
      // remembered whenever the Tools screen loads; with nothing remembered
      // yet, every tool is tried and "no connected account" is a skip, not
      // an error — a pull used to fail loudly over the two tools somebody
      // had never connected.
      let chosen = only ? [only] : availableConnectors(env);
      if (!only) {
        const held = [];
        for (const c of chosen) {
          const cfg = await getConnectorConfig(env.DB, session.github_id, c.id);
          if (cfg?.connected || (c.requiresConfig && cfg)) held.push(c);
        }
        if (held.length) chosen = held;
      }
      const results = await syncAll(chosen, {
        env, session,
        orgId: body.orgId, userId: me.login,
        readerLanguage: body.readerLanguage,
        provider: syncProvider,
      });
      await settleUsage(env.DB, syncProvider, { orgId: body.orgId, githubId: session.github_id });
      // The sync wrote to D1; the sockets live in the Durable Object and heard
      // nothing about it. Announcing here is what puts a card someone just
      // pulled in front of them, instead of on their next reconnect.
      const pulled = [];
      for (const c of await cardsCreatedSince(env.DB, body.orgId, me.login, startedAt)) {
        pulled.push(await localizeForRecipient(env, body.orgId, c, { payerGithubId: session.github_id }));
      }
      await announceCards(env, body.orgId, pulled);

      if (only) {
        const r = results[0];
        return r.error ? json({ message: r.error }, 502) : json({ scanned: r.scanned, created: r.created });
      }
      return json({ results });
    }
    // A question about a card, answered from what the team already knows.
    // Not a card: nobody is asked to decide anything, and nothing is stored
    // but the fact that the question was asked.
    if (url.pathname === "/ai/ask" && request.method === "POST") {
      const limited = await enforce(env, request, "ai/route");
      if (limited) return limited;
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
      const orgId = typeof body.orgId === "string" ? body.orgId : "";
      const cardId = typeof body.cardId === "string" ? body.cardId : "";
      const question = typeof body.question === "string" ? body.question.trim() : "";
      if (!orgId || !cardId) return json({ message: "orgId and cardId are required" }, 400);
      if (!question) return json({ message: "question is required" }, 400);
      if (question.length > 1000) return json({ message: "That question is too long (over 1000 characters)." }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const card = await getCard(env.DB, orgId, cardId);
      if (!card) return json({ message: "no such card" }, 404);
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const userKey = request.headers.get("x-ai-key") || undefined;
      const provider = await providerFor(env, orgId, userKey);
      if (!provider) return json({ message: "Your AI has no model to answer with on this deployment." }, 503);
      const allowance = await allowanceFor(env, orgId, { githubId: String(session.github_id), userKey });
      if (!allowance.allowed) {
        return json({ message: "You have used today's AI answers. Tomorrow, or Pro, brings more.", quotaExceeded: true }, 429);
      }
      let related = [];
      let recent = [];
      let sources = [];
      let playbook = [];
      let talk = [];
      try {
        const terms = searchTermsFor(question, card);
        const available = await connectedSources(env, session, orgId);
        const [decisionsHit, recentHit, notionHit, githubHit, playbookHit, talkHit] = await Promise.all([
          searchDecisions(env.DB, orgId, terms),
          recentDecisions(env.DB, orgId, { limit: 8 }),
          available.notion ? searchNotion(env, session.github_id, terms).catch((err) => { console.error("notion search failed", err?.message || err); return []; }) : [],
          available.github ? searchGithubIssues(session, orgId, terms, env).catch((err) => { console.error("github search failed", err?.message || err); return []; }) : [],
          relevantMemories(env.DB, orgId, `${card.title || ""} ${question}`),
          // What the card's channel has been saying: the conversation the
          // decision came out of is often the answer.
          card.business ? recentBusinessTalk(env.DB, orgId, [card.business], { limit: 12 }).catch(() => []) : [],
        ]);
        talk = talkHit;
        playbook = playbookHit;
        related = decisionsHit;
        recent = recentHit;
        sources = [...notionHit, ...githubHit, ...talk.map((m) => ({ app: "Channel", title: `${m.channel} · ${m.who}`, snippet: m.text, when: m.when }))];
      } catch (err) {
        console.error("ask context failed", err?.message || err);
      }
      const result = await answerQuestion({
        provider, card, question, readerLanguage: body.readerLanguage, recent, related, sources, playbook,
      });
      if (result.called && allowance.metered) await allowance.consume();
      await settleUsage(env.DB, provider, { orgId, githubId: session.github_id, byok: Boolean(userKey) });
      if (!result.answer) return json({ message: "Your AI could not answer that just now." }, 502);
      const user = await getUserByGithubId(env.DB, session.github_id);
      await appendCardEvent(env.DB, orgId, {
        cardId, type: "asked", actorUserId: user?.login || null, note: question.slice(0, 500), snapshot: card,
      });
      return json({
        answer: result.answer,
        related: related.slice(0, 5).map((d) => ({ title: d.title, status: d.status, decidedAt: d.decidedAt, recipient: d.recipient })),
        sources: sources.slice(0, 6).map((r) => ({ app: r.app, title: r.title, url: r.url })),
      });
    }

    // The message back to whoever asked, drafted from the decision. Only the
    // two people on the card can speak for it, and only once it is decided:
    // a reply to a pending card is a promise nobody has made.
    if (url.pathname === "/ai/draft" && request.method === "POST") {
      const limited = await enforce(env, request, "ai/route");
      if (limited) return limited;
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
      const orgId = typeof body.orgId === "string" ? body.orgId : "";
      const cardId = typeof body.cardId === "string" ? body.cardId : "";
      if (!orgId || !cardId) return json({ message: "orgId and cardId are required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const card = await getCard(env.DB, orgId, cardId);
      if (!card) return json({ message: "no such card" }, 404);
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const user = await getUserByGithubId(env.DB, session.github_id);
      if (user?.login !== card.recipientUserID && user?.login !== card.senderUserID) {
        return json({ message: "Only the people on this card can draft its reply." }, 403);
      }
      if (!card.decision || card.status === "pending") {
        return json({ message: "Decide first; the reply follows the decision." }, 409);
      }
      const userKey = request.headers.get("x-ai-key") || undefined;
      const provider = await providerFor(env, orgId, userKey);
      if (!provider) return json({ message: "Your AI has no model to draft with on this deployment." }, 503);
      const allowance = await allowanceFor(env, orgId, { githubId: String(session.github_id), userKey });
      if (!allowance.allowed) {
        return json({ message: "You have used today's AI answers. Tomorrow, or Pro, brings more.", quotaExceeded: true }, 429);
      }
      const playbook = await relevantMemories(env.DB, orgId, `${card.title || ""} ${card.summary || ""}`, { limit: 6 });
      const result = await draftReply({
        provider, card, decider: user?.name || user?.login, readerLanguage: body.readerLanguage, playbook,
      });
      if (result.called && allowance.metered) await allowance.consume();
      await settleUsage(env.DB, provider, { orgId, githubId: session.github_id, byok: Boolean(userKey) });
      if (!result.draft) return json({ message: "Your AI could not draft that just now." }, 502);
      await appendCardEvent(env.DB, orgId, {
        cardId, type: "drafted", actorUserId: user?.login || null, note: result.draft.slice(0, 500), snapshot: card,
      });
      return json({ draft: result.draft, language: result.language });
    }

    // The reply, sent back the way the request came: on the Gmail thread, in
    // the Slack thread. Only for a card this person's own sync made from a
    // message — the ingested record, which no client can write, is the link
    // — and only once it is decided. The text is the person's: the draft,
    // read and changed by them.
    const replyMatch = url.pathname.match(/^\/cards\/([^/]+)\/reply$/);
    if (replyMatch && request.method === "POST") {
      const limited = await enforce(env, request, "ai/route");
      if (limited) return limited;
      const cardId = decodeURIComponent(replyMatch[1]);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
      const orgId = typeof body.orgId === "string" ? body.orgId : "";
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!orgId) return json({ message: "orgId is required" }, 400);
      if (!text) return json({ message: "text is required" }, 400);
      if (text.length > 4000) return json({ message: "That reply is too long (over 4000 characters)." }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const card = await getCard(env.DB, orgId, cardId);
      if (!card) return json({ message: "no such card" }, 404);
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const user = await getUserByGithubId(env.DB, session.github_id);
      if (user?.login !== card.recipientUserID && user?.login !== card.senderUserID) {
        return json({ message: "Only the people on this card can reply for it." }, 403);
      }
      if (!card.decision || card.status === "pending") {
        return json({ message: "Decide first; the reply follows the decision." }, 409);
      }
      if (!env.COMPOSIO_API_KEY) return json({ message: "Connected apps are not on this deployment. Copy the reply and send it yourself." }, 503);
      const item = await ingestedItemForCard(env.DB, cardId, session.github_id);
      if (!item) return json({ message: "This card did not come from a connected app. Copy the reply and send it yourself." }, 409);
      const connector = connectorById(item.connector);
      const tool = connector?.replyTool ? connector.replyTool(card.source || {}, text) : null;
      if (!tool) return json({ message: `A reply cannot go back through ${connector?.label || item.connector} from here. Copy it and send it yourself.` }, 409);
      try {
        await executeTool(env.COMPOSIO_API_KEY, tool.slug, String(session.github_id), tool.args);
      } catch (err) {
        console.error("reply send failed", safe(err?.message || err));
        return json({ message: `${connector.label} did not take the reply. Copy it and send it yourself.` }, 502);
      }
      await appendCardEvent(env.DB, orgId, {
        cardId, type: "replied", actorUserId: user?.login || null, note: text.slice(0, 500), snapshot: card,
      });
      return json({ sent: true, via: connector.label });
    }

    // The team's decisions, by keyword — what the command palette shows
    // under the cards the browser already has. The same search the router
    // and "Ask anything" use, for a person.
    if (url.pathname === "/search" && request.method === "GET") {
      const orgId = url.searchParams.get("orgId") || "";
      const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const hits = q ? await searchDecisions(env.DB, orgId, q, { limit: 12 }) : [];
      return json({ hits });
    }

    // A card in the reader's language, on request. The relay translates for
    // the recipient when a card is made; everyone else — a teammate reading
    // the feed, the sender after switching languages, a recipient whose
    // language changed — asks here. Stored on the card, so the next reader
    // of that language pays nothing, and re-broadcast so every open device
    // shows the same words.
    const localizeMatch = url.pathname.match(/^\/cards\/([^/]+)\/localize$/);
    if (localizeMatch && request.method === "POST") {
      const limited = await enforce(env, request, "cards/localize");
      if (limited) return limited;
      const cardId = decodeURIComponent(localizeMatch[1]);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
      const orgId = typeof body.orgId === "string" ? body.orgId : "";
      // Any language a person reads, not only the five the notification
      // chrome is written in: the card's words are the model's to translate.
      const locale = primaryLanguage(typeof body.locale === "string" ? body.locale.slice(0, 16) : "");
      if (!orgId || !locale) return json({ message: "orgId and locale are required" }, 400);
      if (!languageName(locale)) return json({ message: "That is not a language the relay knows." }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const card = await getCard(env.DB, orgId, cardId);
      if (!card) return json({ message: "no such card" }, 404);
      if (!needsLocalizing(card, locale)) {
        return json({ localized: card.localized?.[locale] || null, already: true });
      }
      const provider = await providerFor(env, orgId, request.headers.get("x-ai-key") || undefined);
      if (!provider) return json({ message: "Your AI has no model to translate with on this deployment." }, 503);
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const allowance = await allowanceFor(env, orgId, { githubId: String(session.github_id), userKey: request.headers.get("x-ai-key") || undefined });
      if (!allowance.allowed) return json({ message: "You have used today's AI answers.", quotaExceeded: true }, 429);
      // A translation is a convenience the client asks for on its own; it
      // must not spend the last of a metered day's allowance, which the
      // person needs for the instruction they are about to type.
      if (allowance.metered && allowance.remaining !== undefined && allowance.remaining <= 1) {
        return json({ message: "Today's AI answers are nearly used up; the card stays in its own language.", quotaExceeded: true }, 429);
      }
      const localized = await localizeCard(card, { provider, locale, allowance });
      await settleUsage(env.DB, provider, { orgId, githubId: session.github_id, byok: Boolean(request.headers.get("x-ai-key")) });
      if (!localized) return json({ message: "Your AI could not translate that just now." }, 502);
      // Only the new words are written: the card may have been decided while
      // the model was translating, and that decision must survive.
      await saveCardLocalization(env.DB, orgId, cardId, locale, localized.localized[locale]);
      const fresh = (await getCard(env.DB, orgId, cardId)) || localized;
      await announceCards(env, orgId, [fresh], { isNew: false });
      return json({ localized: localized.localized[locale] });
    }

    // One card, for any member of its org: what a search hit older than the
    // socket's snapshot opens from. The socket sends the recent window; the
    // palette's "Decided before" reaches past it.
    // The thread under a card: what people said, and one-emoji reactions.
    // Members of the card's workspace only; the author is the session,
    // never the body.
    const commentsMatch = url.pathname.match(/^\/cards\/([^/]+)\/comments$/);
    if (commentsMatch && (request.method === "GET" || request.method === "POST")) {
      const limited = request.method === "POST" ? await enforce(env, request, "team") : null;
      if (limited) return limited;
      const cardId = decodeURIComponent(commentsMatch[1]);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      if (request.method === "POST" && (!body || typeof body !== "object")) return json({ message: "Invalid JSON body." }, 400);
      const orgId = request.method === "GET" ? (url.searchParams.get("orgId") || "") : (typeof body.orgId === "string" ? body.orgId : "");
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const user = await getUserByGithubId(env.DB, session.github_id);
      if (!user) return json({ message: "unknown user" }, 409);
      if (request.method === "GET") {
        const card = await getCard(env.DB, orgId, cardId);
        if (!card) return json({ message: "no such card" }, 404);
        return json({
          comments: await listComments(env.DB, orgId, cardId),
          reactions: await listReactions(env.DB, orgId, cardId, user.login),
          available: REACTIONS,
          maxChars: MAX_COMMENT_CHARS,
        });
      }
      const result = await addComment(env.DB, { orgId, cardId, authorLogin: user.login, body: body.body });
      if (result.error) return json({ message: result.error }, result.status || 400);
      const { comment, card, mentioned } = result;
      // Everyone with the workspace open sees the comment now and the
      // card's count with it; everyone it concerns hears about it.
      after(ctx, async () => {
        await announceEvents(env, orgId, [customEvent("comment", { cardId, comment })]);
        await announceCards(env, orgId, [card], { isNew: false });
        if (!anyChannelConfigured(env)) return;
        const who = { author: user.login, name: user.name || null, text: comment.body };
        const told = new Set([user.login]);
        for (const login of mentioned) {
          if (told.has(login)) continue;
          told.add(login);
          await notifyCard(env, { card, kind: "mentioned", toLogin: login, comment: who, orgId, payerGithubId: session.github_id });
        }
        for (const login of [card.recipientUserID, card.senderUserID]) {
          if (!login || told.has(login) || login === "deleted-user") continue;
          told.add(login);
          await notifyCard(env, { card, kind: "commented", toLogin: login, comment: who, orgId, payerGithubId: session.github_id });
        }
      });
      return json({ comment, card }, 201);
    }
    const reactionsMatch = url.pathname.match(/^\/cards\/([^/]+)\/reactions$/);
    if (reactionsMatch && request.method === "POST") {
      const limited = await enforce(env, request, "team");
      if (limited) return limited;
      const cardId = decodeURIComponent(reactionsMatch[1]);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
      const orgId = typeof body.orgId === "string" ? body.orgId : "";
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const user = await getUserByGithubId(env.DB, session.github_id);
      if (!user) return json({ message: "unknown user" }, 409);
      const result = await toggleReaction(env.DB, { orgId, cardId, login: user.login, emoji: String(body.emoji || "") });
      if (result.error) return json({ message: result.error }, result.status || 400);
      after(ctx, async () => {
        await announceEvents(env, orgId, [customEvent("reaction", { cardId, emoji: body.emoji, on: result.on, by: user.login, reactions: result.card.reactions })]);
        await announceCards(env, orgId, [result.card], { isNew: false });
      });
      return json({ on: result.on, reactions: result.reactions, card: result.card });
    }

    const cardById = url.pathname.match(/^\/cards\/([^/]+)$/);
    if (cardById && request.method === "GET") {
      const cardId = decodeURIComponent(cardById[1]);
      const orgId = url.searchParams.get("orgId") || "";
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const card = await getCard(env.DB, orgId, cardId);
      if (!card) return json({ message: "no such card" }, 404);
      return json({ card });
    }

    // One card's history, for any member of its org. The older route is
    // keyed by owner/repo and cannot name a personal or email workspace;
    // this one takes the org id every other route takes.
    const cardEventsById = url.pathname.match(/^\/cards\/([^/]+)\/events$/);
    if (cardEventsById && request.method === "GET") {
      const cardId = decodeURIComponent(cardEventsById[1]);
      const orgId = url.searchParams.get("orgId") || "";
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      return json({ events: await withActorNames(env.DB, await listCardEvents(env.DB, orgId, cardId)) });
    }

    // What a person thought of a card. The one signal that turns "the AI
    // routed it wrong" from a feeling into a row the eval set can be built
    // from. Sender or recipient only: they are the two who can know.
    const feedbackMatch = url.pathname.match(/^\/cards\/([^/]+)\/feedback$/);
    if (feedbackMatch && request.method === "POST") {
      const cardId = decodeURIComponent(feedbackMatch[1]);
      const body = await request.json().catch(() => ({}));
      const orgId = typeof body.orgId === "string" ? body.orgId : "";
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      if (!FEEDBACK_VERDICTS.has(body.verdict)) return json({ message: "verdict must be right or wrong" }, 400);
      if (body.reason !== undefined && body.reason !== null && !FEEDBACK_REASONS.has(body.reason)) {
        return json({ message: "unknown reason" }, 400);
      }
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const user = await getUserByGithubId(env.DB, session.github_id);
      const card = await getCard(env.DB, orgId, cardId);
      if (!card) return json({ message: "no such card" }, 404);
      if (card.recipientUserID !== user?.login && card.senderUserID !== user?.login) {
        return json({ message: "Only the sender or the recipient can rate this card." }, 403);
      }
      await recordFeedback(env.DB, {
        orgId, cardId, githubId: session.github_id,
        verdict: body.verdict, reason: body.reason || null, note: body.note || null,
      });
      await appendCardEvent(env.DB, orgId, {
        cardId, type: "feedback", action: body.verdict, actorUserId: user?.login || null,
        note: body.reason || null, snapshot: card,
      });
      return json({ ok: true });
    }

    // How the feed is doing for this team, from the cards themselves.
    if (url.pathname === "/metrics" && request.method === "GET") {
      const orgId = url.searchParams.get("orgId") || "";
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      return json(await orgMetrics(env.DB, orgId, { days: url.searchParams.get("days") }));
    }

    // Real cards, with their verdicts, in the shape the eval harness reads.
    if (url.pathname === "/eval/export" && request.method === "GET") {
      const orgId = url.searchParams.get("orgId") || "";
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      return json({ entries: await exportGolden(env.DB, orgId, { limit: url.searchParams.get("limit") }) });
    }

    const orgEventsMatch = url.pathname.match(/^\/orgs\/([^/]+)\/([^/]+)\/events$/);
    if (orgEventsMatch && request.method === "GET") {
      const [, owner, repo] = orgEventsMatch;
      const orgId = `${owner}/${repo}`;
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      // Positive, or the default. `Number("-1") || 50` is -1, and SQLite
      // reads a negative LIMIT as "no limit" — every event the org has ever
      // logged, each with a full card snapshot, in one response.
      const asked = Number.parseInt(url.searchParams.get("limit") || "", 10);
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 50;
      return json({ events: await listOrgEvents(env.DB, orgId, limit) });
    }
    // GitHub, reached through us. The app used to hold the access token and
    // call GitHub directly; it now holds a session and calls this, which
    // forwards exactly the six things the app does and nothing else.
    if (url.pathname === "/github" || url.pathname.startsWith("/github/")) {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const limited = await enforce(env, request, "github");
      if (limited) return limited;
      return proxyGitHub(request, env, url, session);
    }

    // Mail arrives here rather than being fetched. Everything after arrival is
    // the same path Gmail and Slack take: triage, a card, an announcement to
    // whoever has the app open, and a notification to whoever does not.
    if (url.pathname === "/webhooks/email" && request.method === "POST") {
      const limited = await enforce(env, request, "webhooks/email");
      if (limited) return limited;

      let fields;
      try {
        const type = request.headers.get("content-type") || "";
        fields = type.includes("application/json")
          ? new Map(Object.entries(await request.json()))
          : await request.formData();
      } catch {
        return json({ message: "Unreadable webhook body." }, 400);
      }
      const read = (n) => (fields.get ? fields.get(n) : undefined);

      if (!(await verifyMailgunWebhook(env, {
        timestamp: read("timestamp"), token: read("token"), signature: read("signature"),
      }))) {
        return json({ message: "Invalid webhook signature." }, 401);
      }

      const message = parseMailgunWebhook(fields);
      if (!message) return json({ message: "No message in the webhook." }, 400);

      // The address carries a per-user secret, not an id. No token, nothing to
      // do — answered 200 because Mailgun retries a non-2xx, and retrying will
      // not make the address resolve.
      if (!inboundTokenFromAddress(message.recipient)) return json({ status: "unroutable" });
      const user = await userForInboundAddress(env, message.recipient);
      if (!user?.login) return json({ status: "unknown recipient" });
      const githubId = user.github_id;

      // Where this person works, by the same rule a sign-in uses. `LIMIT 1`
      // with no ordering picked whichever membership row the database reached
      // first — invisible while almost everybody was in exactly one
      // organization, and wrong the moment joining a team became ordinary: a
      // forwarded email would land in a workspace by accident of insertion
      // order rather than in the one they actually work in.
      const orgId = await primaryOrgId(env.DB, githubId);
      if (!orgId) return json({ status: "no organization" });

      // A redelivered webhook is the same mail, not a second decision.
      if (await isIngested(env.DB, "email", message.id, githubId)) {
        return json({ status: "duplicate" });
      }

      const allowance = await allowanceFor(env, orgId, { githubId: String(githubId) });
      const provider = allowance.allowed ? await providerFor(env, orgId) : undefined;
      const result = provider
        ? await triageMessage(message, { provider, readerLanguage: user.locale || "en", sourceLabel: "Email" })
        : { called: false, card: null };
      if (result.called && allowance.metered) await allowance.consume();
      await settleUsage(env.DB, provider, { orgId, githubId });

      let cardId = null;
      if (result.card) {
        cardId = crypto.randomUUID();
        const business = await fileCardUnderBusiness(env, {
          orgId, provider, githubId,
          card: { ...result.card, sourceDetail: `${message.from} · ${message.subject}` },
          allowance: await allowanceFor(env, orgId, { githubId: String(githubId) }),
        });
        const card = {
          id: cardId,
          ...(business ? { business } : {}),
          recipientUserID: user.login,
          senderUserID: user.login,
          type: result.card.cardType,
          format: "approve",
          title: result.card.title,
          summary: result.card.summary,
          context: result.card.context,
          priority: result.card.priority,
          status: "pending",
          createdAt: new Date().toISOString(),
          sourceApp: "Email",
          sourceDetail: `${message.from} · ${message.subject}`,
        };
        await saveCard(env.DB, orgId, card);
        const shown = await localizeForRecipient(env, orgId, card, { payerGithubId: githubId });
        await announceCards(env, orgId, [shown]);
        // notifyCard never throws, and this handler has no ctx to defer with.
        await notifyCard(env, { card: shown, kind: "created", excludeLogin: null });
      }

      await markIngested(env.DB, {
        connector: "email", externalId: message.id, githubId, orgId, cardId,
      });
      return json({ status: cardId ? "card created" : "no decision needed" });
    }

    // Where to send mail so it reaches you. The address carries a secret only
    // this account can have minted, which is what makes routing an inbound
    // message safe at all.
    if (url.pathname === "/connectors/email/address" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const address = await inboundAddressFor(env, session.github_id);
      return address
        ? json({ address })
        : json({ message: "Inbound email is not configured on this deployment." }, 503);
    }

    if (request.headers.get("Upgrade") === "websocket") {
      // A socket belongs to one workspace, named by the client. There is no
      // default: a client that has lost its orgId asks /me for its
      // workspaces, it does not land in a shared placeholder team.
      const orgId = url.searchParams.get("orgId");
      if (!orgId || !orgId.trim()) return json({ message: "orgId is required" }, 400);
      const id = env.ORG_RELAY.idFromName(orgId);
      const stub = env.ORG_RELAY.get(id);
      return stub.fetch(request);
    }
    return new Response("not found", { status: 404 });
}

// Allow browser clients (the web app) to call this API. Native apps are not
// subject to CORS, so this was never needed until the web client. Every JSON
// response carries these — including the ones that are not built here, like a
// rate limiter's 429, or a browser cannot read the body that says when to
// come back.
export const CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
});

export function json(body, status = 200, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      // Nothing this API answers with JSON is for a cache: session tokens,
      // a person's settings, a team's invite codes. `/media` sets its own.
      "cache-control": "no-store",
      ...(extraHeaders || {}),
      "content-type": "application/json",
      ...CORS_HEADERS,
    },
  });
} 
