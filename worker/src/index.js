Warning: truncated output (original token count: 47627)
Total output lines: 3054

import {maintainDocumentJobs} from './harness/documentMaintenance.js';
import {retryWorkflowNotices} from './harness/workflowNoticeDelivery.js';
import {drainAgentHandoffs} from './harness/agentHandoffDispatch.js';
import {drainAgentRequests} from './agentRequestDispatch.js';
import { drainRoomHookDispatch } from './harness/roomHookDispatch.js';
import { handleRoomHook } from './harness/roomHookRoute.js';
import { archiveManagedRoom, deleteManagedRoom, roomRoleState } from './harness/roomRoles.js';
import { customRunner } from "./harness/customRunner.js";
import { expireGatewayJobs } from './harness/gateways.js';
import { drainCardNotifications } from './notificationJobs.js';
import { notifyCardNow } from './notify.js';
import { routeInstruction } from "./routing.js";
import { toolManifest } from "./agui/tools.js";
import { signup, login, createInvite, acceptInvite, isGitHubSession, inviteLink, peekInvite } from "./auth.js";
import { requestCode, verifyCode } from "./otp.js";
import { handleWellKnown } from "./wellKnown.js";
import {
  createSession, getSession, upsertUser, upsertMembership, upsertAgent, isMember, listOrgNodes,
  getConnectorConfig, setConnectorConfig, rememberPullWorkspace, ingestWorkspaceOf, createOAuthState, consumeOAuthState,
  getUserByGithubId, getUserByLogin, registerDevice, removeDevice, retainMemberships, cardsCreatedSince,
  isIngested, markIngested, saveCard,
  saveCardLocalization, setUserLocale, setUserNotifyEmail, setUserEmail, normalizeLocale,
  registerSubscription, removeSubscription, listBusinesses, hasPrivateBusinesses, upsertBusiness, createPrivateBusiness, removeBusiness, businessSlug, renameBusiness,
  rememberConnections, getCard, normalizeAliases, setUserAliases, parseAliases,
  setOwnTitle, ownTitle, SELF_ASSIGNABLE_ROLES, listUserOrgs, primaryOrgId,
  loadContexts, saveContext, cleanName, checkHandle, setUserName, setUserHandle, MAX_NAME_CHARS,
} from "./db.js";
import { enforce } from "./ratelimit.js";
import { announceCards, evictMember, evictRoomJam, announceEvents, announceTo } from "./announce.js";
import { custom as customEvent } from "./agui/events.js";
import { contextEvents } from "./agui/adapter.js";
import { verifyMailgunWebhook, parseMailgunWebhook, inboundTokenFromAddress, userForInboundAddress, inboundAddressFor } from "./connectors/email.js";
import { triageMessage } from "./triage.js";
import { notifyCard, anyChannelConfigured } from "./notify.js";
import { proxyGitHub } from "./githubProxy.js";
import { deleteAccount, exportAccount } from "./account.js";
import { listMembers, listMembersForClient, removeMember, previewMemberDeparture, listInvites, revokeInvite, membershipIsOurs, returnOrphanedCards, changeRole, memberRef } from "./team.js";
import { authorizeOrgAccess } from "./membership.js";
import { isConfigured, isDeviceToken } from "./apns.js";
import { isFcmToken, isFcmConfigured } from "./fcm.js";
import { isWebPushConfigured, parseSubscription } from "./webpush.js";
import { isMailConfigured, sendMail } from "./mailer.js";
import { SUPPORTED_LOCALES, composeInviteEmail, t } from "./notifyCopy.js";
import { loadCopy } from "./copy.js";
import { createTeam, renameTeam, teamName, canRename } from "./orgs.js";
import { settleUsage, jevEntry } from "./ledger.js";
import { runScheduledSync, runAutomations } from "./scheduled.js";
import { handleAutomation } from "./automation.js";
import { handleHarness } from "./harness/routes.js";
import { runDueWorkflows, handleWorkflowHook } from "./harness/workflows.js";
import { runDueFollowups } from "./harness/followups.js";
import { handleChannels, broadcastStored, deliverAcceptedMessages, watchTeammateRuns, caller } from "./channelRoutes.js";
import { handleAudit, audit, auditEverywhere, person, migrateLegacyAudit } from "./audit.js";
import { shredPerson } from "./auditCrypto.js";
import { allowed, ensureOwner, soleOwnerships } from "./permissions.js";
import { handlePolicy, policyDenial, reauthDenial } from "./policy.js";
import { PROVIDERS, loadTeammate, saveTeammate, toClientTeammate, spentThisMonth } from "./teammates.js";
import { handleOrgKeys, warnExpiringKeys } from "./orgKeys.js";
import { handleAdminApi } from "./adminApi.js";
import { handleScim } from "./scim.js";
import { handleDlp } from "./dlp.js";
import { handleDomains, recheckDomains } from "./domains.js";
import { handleSso, checkSsoGrants } from "./sso.js";
import { finishRemoteMcpOAuth, remoteMcpOAuthClientMetadata } from "./harness/remoteMcpOAuth.js";
import { handleApps, sweepAppConnections, forgetAppConnections } from "./smitheryApps.js";
import { requestContext } from "./requestContext.js";
import { settleCors } from "./cors.js";
import { handleMcp, authenticateMcpRequest } from "./mcp.js";
import { handleMcpContentUpload } from "./mcpContentTools.js";
import { handleMcpOAuth, sweepMcpOAuth } from "./mcpOAuth.js";
import { handleGovernance, pruneMessages, expireExports } from "./governance.js";
import { sealPending, weeklyVerify } from "./auditArchive.js";
import { pruneAudit, handleOps } from "./auditRetention.js";
import { deliverStreams, handleStreams } from "./auditStreams.js";
import { handleOwners, transferFor, mailOwners } from "./owners.js";
import { handleSessions, signedIn } from "./sessions.js";
import { handleSuggestions } from "./suggest.js";
import { handleWebhooks } from "./webhooks.js";
import { handleAgentInvites } from "./agentInvites.js";
import { handleUserAvatar } from "./userAvatar.js";
import { serveFile, freshFileUrls } from "./files.js";
import { useMediaEnv, mediaOriginOn, signVideoUrl } from "./mediaToken.js";
import { membersOf, isPrivate, mayRead, mayReadCard, accessFor, isGuest, hasGuests } from "./access.js";
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
import { saveWorkspaceAIBudget } from "./workspaceAIBudget.js";
import { githubStatus, connectWorkspaceGitHub, connectWorkspaceGitHubAs, disconnectWorkspaceGitHub, githubConnectLink, listMyRepositories, myGithubAccount, getWorkspaceGitHub } from "./githubWorkspace.js";
import { localizeCard, needsLocalizing, localizeForRecipient } from "./localize.js";
import { primaryLanguage, languageName } from "./language.js";
import { connectedSources, lookupsFor, searchNotion, searchGithubIssues } from "./context.js";
import { ingestedItemForCard } from "./db.js";
import { alert } from "./alert.js";
import { serverText } from "./serverCopy.js";
import { listCardEvents, listOrgEvents, appendCardEvent, withActorNames } from "./events.js";
import { listComments, addComment, listReactions, toggleReaction, REACTIONS, MAX_COMMENT_CHARS } from "./threads.js";
import { useSecretKey } from "./secrets.js";
import { useMirrorEnv } from "./store/mirror.js";
import { fetchCollaborators } from "./github.js";
import { buildOrgGraph, roleName } from "./org.js";
import { uploadMedia, serveMedia } from "./media.js";
import { uploadOrgIcon, removeOrgIcon, serveOrgIcon, getOrgIcon, iconsFor, iconUrl } from "./orgIcon.js";
import { listEmoji, addEmoji, removeEmoji, serveEmoji } from "./emoji.js";
import { cleanSchedule, parseSchedule, pauseUntil, cleanKeywords, parseKeywords } from "./quiet.js";

/// Quiet time as a client shows it: paused until when, and the hours.
const quietFields = (user) => ({
  notifyPausedUntil: user?.notify_paused_until && Date.parse(user.notify_paused_until) > Date.now() ? user.notify_paused_until : null,
  notifySchedule: parseSchedule(user?.notify_schedule),
  notifyKeywords: parseKeywords(user?.notify_keywords),
});
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
export { AgentRunner } from "./agentRunner.js";
export { WorkspaceDO } from "./workspace/do.js";

/// Whether one of this person's workspaces holds their address to its single
/// sign-on — the address then stays where the company put it.
async function ssoHoldsEmail(env, githubId) {
  const { ssoRequiredFor } = await import("./sso.js");
  for (const org of await listUserOrgs(env.DB, githubId)) {
    if (await ssoRequiredFor(env.DB, org.id, githubId)) return true;
  }
  return false;
}

/// Whether this person may change where mail goes, by the same rules `PUT
/// /me` applies. An email account signs in with its address; an account a
/// company's identity provider or directory made, or one a workspace holds
/// to its SSO, has the address the company gave it (`emailManaged`).
async function emailCapability(env, user) {
  const id = String(user.github_id);
  if (id.startsWith("email:")) return { emailEditable: false, emailManaged: false };
  const managed = id.startsWith("sso:") || id.startsWith("scim:") || await ssoHoldsEmail(env, id);
  return { emailEditable: !managed, emailManaged: managed };
}

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

/// A channel somebody may rename, delete or archive: any public one, a
/// private one only from inside — and never a guest's to touch, who is let
/// into a channel to talk in it, not to take it away from the team.
async function canTouchChannel(db, orgId, slug, login) {
  if (!login) return false;
  const access = await accessFor(db, orgId, login);
  if (access.guest) return false;
  if (!(await isPrivate(db, orgId, slug))) return true;
  return mayRead(`b:${slug}`, access);
}

/// Tell each of these people their own list of channels again — after a
/// private channel they are in was made, changed or deleted.
async function tellMembers(env, orgId, logins) {
  await announceTo(env, orgId, await Promise.all([...new Set(logins)].map(async (login) => ({
    to: login, event: customEvent("businesses", { businesses: await listBusinesses(env.DB, orgId, { viewer: login }) }),
  }))));
}

/// The person behind a session, as the audit log names them.
async function actorOf(env, session) {
  return person(await getUserByGithubId(env.DB, session.github_id));
}

/// An admin action asks for a recent sign-in where the workspace says so,
/// and an owner's always does (policy.js). A Response, or null to go on.
async function requireRecentAuth(env, request, orgId) {
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "invalid session" }, 401);
  const role = (await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(orgId, String(session.github_id)).first())?.role;
  const again = await reauthDenial(env, session, orgId, { owner: role === "owner" });
  return again ? json(again.body, again.status) : null;
}

async function requireMember(env, request, orgId) {
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "invalid session" }, 401);
  if (!(await isMember(env.DB, orgId, session.github_id))) {
    return json({ message: "not a member of this org" }, 403);
  }
  // This workspace's login rules: a session it has outgrown signs in again.
  const held = await policyDenial(env, session, orgId);
  return held ? json(held.body, held.status) : null;
}

/// What the caller may see of this workspace's cards (access.js): a guest
/// only the cards they are on, anyone else all but a private channel's.
async function cardAccess(env, request, orgId) {
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  const me = session ? await getUserByGithubId(env.DB, session.github_id) : null;
  return accessFor(env.DB, orgId, me?.login || "");
}
const hiddenCard = async (env, request, orgId, card) => !card || !mayReadCard(card, await cardAccess(env, request, orgId));
const guestRefused = async (env, request, orgId) => (await cardAccess(env, request, orgId)).guest
  ? json({ message: "A guest sees only the decisions they are on." }, 403) : null;

export default {
  // Every 15 minutes, so a decision that arrived in someone's inbox is already
  // a card by the time they look. Nothing here bypasses the free-tier meter:
  // the sync loop checks the same allowance a manual sync does.
  async scheduled(event, env, ctx) {
    useSecretKey(env);
    useMirrorEnv(env);
    useMediaEnv(env);
    // Every minute: scheduled messages and Later reminders, which a person
    // set to a minute and would notice fifteen late.
    if (event?.cron === "* * * * *") {
      ctx.waitUntil(drainCardNotifications(env, notifyCardNow).catch(() => console.error("notification retry drain failed")));
      ctx.waitUntil(runMinuteJobs(env, { now: new Date(event?.scheduledTime || Date.now()), broadcast: (orgId, key, row) => broadcastStored(env, orgId, key, row) })
        .catch((err) => console.error("minute jobs failed", err?.message || err)));
      for (const kind of ['live', 'push']) ctx.waitUntil(deliverAcceptedMessages(env, { kind }));
      ctx.waitUntil(drainAgentRequests(env).catch(() => console.error("agent request dispatch failed")));
      ctx.waitUntil(drainAgentHandoffs(env).catch(() => console.error("agent handoff dispatch failed")));
      ctx.waitUntil(drainRoomHookDispatch(env).catch(() => console.error("room webhook dispatch failed")));
      ctx.waitUntil(maintainDocumentJobs(env.DB).catch(() => console.error("document expiry failed")));
      ctx.waitUntil(expireGatewayJobs(env.DB).catch(() => console.error("gateway expiry failed")));
      // The harness: follow-ups and scheduled workflows whose time has come.
      ctx.waitUntil(runDueFollowups(env, { now: new Date(event?.scheduledTime || Date.now()) }).catch((err) => console.error("follow-ups failed", err?.message || err)));
      ctx.waitUntil(retryWorkflowNotices(env).catch(err=>console.error('workflow notice sweep failed',err?.message)));
      ctx.waitUntil(runDueWorkflows(env, { now: new Date(event?.scheduledTime || Date.now()) }).catch((err) => console.error("workflows failed", err?.message || err)));
      // AI teammates at work: whatever they have finished, posted back.
      ctx.waitUntil(watchTeammateRuns(env).catch((err) => console.error("teammate watch failed", err?.message || err)));
      // The audit log, to each workspace's SIEM, as it is written.
      ctx.waitUntil(deliverStreams(env, { now: event?.scheduledTime || Date.now() }).catch((err) => console.error("audit streams failed", err?.message || err)));
      return;
    }
    // The bill: today's D1 rows against the warning and stop lines. Past
    // the stop line, the work below that nobody is waiting on waits for
    // tomorrow (spendGuard.js); what people do keeps working.
    const { checkSpend, braked } = await import("./spendGuard.js");
    await checkSpend(env, ctx, { now: event?.scheduledTime || Date.now() }).catch((err) => console.error("spend check failed", err?.message || err));
    if (await braked(env)) {
      console.error("spend brake on: background work paused until 00:00 UTC");
      return;
    }
    ctx.waitUntil(runScheduledSync(env, ctx));
    // App connections whose person left or whose app was taken away, ended.
    ctx.waitUntil(sweepMcpOAuth(env).catch(err => console.error("MCP OAuth sweep failed", err?.message)));
    ctx.waitUntil(sweepAppConnections(env).catch((err) => console.error("app sweep failed", err?.message || err)));
    // SSO sign-ins the identity provider no longer stands behind, ended.
    ctx.waitUntil(checkSsoGrants(env, { now: event?.scheduledTime || Date.now(), limit: 200 }).catch((err) => console.error("sso grant check failed", err?.message || err)));
    // Phase 1 audit rows, a few workspaces at a time, into per-person
    // encryption. Nothing to do once every row is.
    ctx.waitUntil(migrateLegacyAudit(env).catch((err) => console.error("audit migration failed", err?.message || err)));
    // Secrets written before sealing, sealed — a batch per table each run.
    ctx.waitUntil(import("./secrets.js").then(({ sealLegacySecrets }) => sealLegacySecrets(env))
      .catch((err) => console.error("secret sealing failed", err?.message || err)));
    // Once a day: workspace keys about to expire, told to their owners.
    const at = new Date(event?.scheduledTime || Date.now());
    if (at.getUTCHours() === 0 && at.getUTCMinutes() < 15) {
      ctx.waitUntil(warnExpiringKeys(env).catch((err) => console.error("key expiry warning failed", err?.message || err)));
      // Every proved domain, looked at again.
      ctx.waitUntil(recheckDomains(env).catch((err) => console.error("domain recheck failed", err?.message || err)));
      // What sessions and presence leave behind, swept.
      ctx.waitUntil(import("./sessions.js").then(({ pruneSessionTraces }) => pruneSessionTraces(env.DB, { now: at.getTime() }))
        .catch((err) => console.error("session sweep failed", err?.message || err)));
      // Dual-writing workspaces: their Durable Object made to match D1.
      ctx.waitUntil(import("./store/mirror.js").then(({ reconcileAll }) => reconcileAll(env))
        .catch((err) => console.error("reconcile failed", err?.message || err)));
      // Caches and meters past the longest anything reads them.
      ctx.waitUntil(import("./retention.js").then(({ pruneGrowth }) => pruneGrowth(env.DB, { now: at.getTime() }))
        .catch((err) => console.error("growth pruning failed", err?.message || err)));
    }
    // Once an hour: the hours just gone, sealed into the archive.
    if (at.getUTCMinutes() < 15) {
      ctx.waitUntil(sealPending(env, { now: at.getTime() }).catch((err) => console.error("audit sealing failed", err?.message || err)));
      ctx.waitUntil(import('./harness/fileMaintenance.js').then(({maintainWorkspaceFiles})=>maintainWorkspaceFiles(env,{now:at.getTime()}))
        .catch(()=>console.error('workspace file maintenance failed')));
    }
    // Once a day: messages and files past a workspace's retention go, and
    // compliance exports past their week.
    if (at.getUTCHours() === 5 && at.getUTCMinutes() < 15) {
      ctx.waitUntil(pruneMessages(env, { now: at.getTime() }).catch((err) => console.error("message retention failed", err?.message || err)));
      ctx.waitUntil(expireExports(env, { now: at.getTime() }).catch((err) => console.error("export expiry failed", err?.message || err)));
      ctx.waitUntil(import("./threadShares.js").then(({ expireThreadShares }) => expireThreadShares(env.DB, at.getTime()))
        .catch((err) => console.error("thread share expiry failed", err?.message || err)));
    }
    // Once a day: workspaces whose thirty days are up, deleted.
    if (at.getUTCHours() === 6 && at.getUTCMinutes() < 15) {
      ctx.waitUntil(import("./workspaceDeletion.js").then(({ purgeDueWorkspaces }) => purgeDueWorkspaces(env, { now: at.getTime() }))
        .catch((err) => console.error("workspace deletion failed", err?.message || err)));
    }
    // Once a day: sealed rows past their retention leave D1.
    if (at.getUTCHours() === 4 && at.getUTCMinutes() < 15) {
      ctx.waitUntil(pruneAudit(env, { now: at.getTime() }).catch((err) => console.error("audit pruning failed", err?.message || err)));
    }
    // Sundays: the last eight days of every archive, checked end to end.
    if (at.getUTCDay() === 0 && at.getUTCHours() === 3 && at.getUTCMinutes() < 15) {
      ctx.waitUntil(weeklyVerify(env, { now: at.getTime() }).catch((err) => console.error("audit verify failed", err?.message || err)));
    }
    // Routines whose hour has come, and once a day the automations the AI
    // would propose. Separate from the sync, so a slow inbox cannot make a
    // Monday report late.
    ctx.waitUntil(runAutomations(env, ctx, new Date(event?.scheduledTime || Date.now())));
  },

  async fetch(request, env, ctx) {
    useSecretKey(env);
    useMirrorEnv(env);
    useMediaEnv(env);
    // Every response carries the id its log line was written under, so a user
    // reporting "it failed" hands over something that finds the line.
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url);
    if (url.pathname === "/custom-app-runner" && request.method === "GET") return customRunner();
    const route = routeLabel(request.method, url.pathname);
    try {
      const response = await requestContext.run({ ip: request.headers.get("cf-connecting-ip") || null }, () => handle(request, env, url, ctx));
      logJSON({ requestId, route, status: response.status, ms: Date.now() - startedAt });
      // A 101 carries the client end of the socket pair on a property, not in
      // the body. Rebuilding it to add a header would hand back a response with
      // no socket attached — every realtime connection, silently dead.
      if (response.status === 101 || response.webSocket) return response;
      const headers = new Headers(response.headers);
      headers.set("x-request-id", requestId);
      settleCors(request, url, env, headers);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (err) {
      // An unhandled throw used to become a raw Workers 500 with a stack trace
      // in it. A malformed JSON body was enough.
      //
      // D1 refusing queries past the free tier's daily rows is an outage, not
      // a bug in the request: 503, named as such, so a client can say the
      // service is down rather than that the network is.
      const outage = isDatabaseLimit(err);
      const status = outage ? 503 : 500;
      logJSON({ requestId, route, status, ms: Date.now() - startedAt, error: safe(err?.message) });
      alert(ctx, env, outage ? "d1-limit" : "unhandled", `${route} ${requestId} ${safe(err?.message)}`);
      return new Response(
        JSON.stringify(outage
          ? { message: "The service is temporarily unavailable. Try again later.", code: "service-unavailable", requestId }
          : { message: "Something went wrong on our side.", requestId }),
        // With the CORS headers every other answer has. Without them the
        // browser hides the response, and the web app could only report it
        // as "could not reach the server".
        { status, headers: (() => { const h = new Headers({ "cache-control": "no-store", "content-type": "application/json", ...CORS_HEADERS, "x-request-id": requestId }); settleCors(request, url, env, h); return h; })() }
      );
    }
  },
};

/// Whether the keys that keep data and the audit log sealed are set.
/// Without DATA_KEY secrets are stored as they are; without the audit keys
/// the log is written in the clear.
export function encryptionReady(env) {
  const data = Boolean(env.DATA_KEY);
  const audit = Boolean(env.AUDIT_MASTER_KEY && env.AUDIT_PSEUDONYM_KEY && env.AUDIT_SIGNING_KEY);
  const sso = Boolean(env.SSO_SECRET_KEY);
  return { data, audit, sso, all: data && audit && sso };
}
const requiresEncryption = (env) => String(env.REQUIRE_ENCRYPTION || "") === "1";

async function handle(request, env, url, ctx) {
    // A production Worker without its keys answers nothing but /health,
    // rather than storing what it should seal in the clear.
    if (requiresEncryption(env) && url.pathname !== "/health" && !encryptionReady(env).all) {
      return json({ message: "The service is not fully configured. Try again shortly.", code: "service-unavailable" }, 503);
    }
    if (url.pathname === "/.well-known/oauth-client") {
      if (request.method === "GET") return remoteMcpOAuthClientMetadata(url, env);
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
    }
    // Browsers send a preflight OPTIONS before a cross-origin POST with custom
    // headers. Answer it with the CORS headers and no body.
    if ((url.pathname === "/mcp" || /^\/mcp\/(?:oauth\/(?:token|revoke)$|uploads\/|files\/)/.test(url.pathname)) && request.method === "OPTIONS") return handleMcp(request, env, ctx);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, x-session-token, x-ai-key, authorization, mcp-session-id, mcp-protocol-version, idempotency-key",
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        },
      });
    }

    if (/^\/mcp\/(uploads|files)\//.test(url.pathname)) {
      const authentication = await authenticateMcpRequest(request, env);
      if (authentication.response) return authentication.response;
      const response = await handleMcpContentUpload(request, env, url, authentication.actor);
      if (!response) return new Response(null, { status: 404 });
      const headers = new Headers(response.headers);
      headers.set("access-control-allow-origin", "*");
      return new Response(response.body, { status: response.status, headers });
    }
    const oauthResponse = await handleMcpOAuth(request, env, url);
    if (oauthResponse) return oauthResponse;

    // What lets the phone apps open links to the web app (src/wellKnown.js).
    if (url.pathname.startsWith("/.well-known/")) {
      const known = handleWellKnown(request, env, url);
      if (known) return known;
    }

    // Remote MCP OAuth returns to this one-time state-bound callback. The
    // state itself binds the exchange to its initiating workspace member.
    if (url.pathname === "/remote-mcp/oauth/callback") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      return finishRemoteMcpOAuth(env, url);
    }

    // Conversations from a workspace's own Durable Object (PoC, off unless
    // WORKSPACE_V2 names the workspace).
    if (url.pathname.startsWith("/v2/w/")) {
      const { handleV2 } = await import("./workspace/v2.js");
      const v2 = await handleV2(request, env, url);
      if (v2) return v2;
    }

    // Single sign-on: discovery, the round trip, and its settings.
    const sso = await handleSso(request, env, url);
    if (sso) return sso;
    // Apps through Smithery: the owner's list, and each person's own.
    const apps = await handleApps(request, env, url);
    if (apps) return apps;
    // Retention, legal holds, compliance exports, networks, invitations.
    const governed = await handleGovernance(request, env, url);
    if (governed) return governed;
    // Where you are signed in, and the audit log.
    const sessions = await handleSessions(request, env, url);
    if (sessions) return sessions;
    // Where the audit log streams to, and the operator's holds.
    const streams = await handleStreams(request, env, url);
    if (streams) return streams;
    const ops = await handleOps(request, env, url);
    if (ops) return ops;
    const audited = await handleAudit(request, env, url);
    if (audited) return audited;
    // Handing the workspace on.
    const owned = await handleOwners(request, env, url);
    if (owned) return owned;
    // The admin API, for a workspace's own keys, and the keys themselves.
    const adminApi = await handleAdminApi(request, env, url);
    if (adminApi) return adminApi;
    // The company's identity provider keeping the member list.
    const scimmed = await handleScim(request, env, url);
    if (scimmed) return scimmed;
    // What a workspace does not want said in it.
    const dlp = await handleDlp(request, env, url);
    if (dlp) return dlp;
    const orgKeys = await handleOrgKeys(request, env, url);
    if (orgKeys) return orgKeys;
    // A company's domains, and who joins by them.
    const domains = await handleDomains(request, env, url);
    if (domains) return domains;
    // A workspace's login rules, and proving it is you again.
    const ruled = await handlePolicy(request, env, url);
    if (ruled) return ruled;

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

    // The harness: mode, Tables, Apps, agents as members, Workflows
    // (docs/kylon-gap-plan.md).
    // A workflow's webhook: called from outside, its secret is the key.
    const roomHook = await handleRoomHook(request, env, url, ctx);
    if (roomHook) return roomHook;
    const workflowHook = await handleWorkflowHook(request, env, url);
    if (workflowHook) return workflowHook;
    const harnessed = await handleHarness(request, env, url, { after: work => after(ctx, work), dispatch: inner => handle(inner, env, new URL(inner.url), ctx) });
    if (harnessed) return harnessed;

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
      // Named fields only. Spreading the body let a caller send
      // `passwordless: true` (or `emailProved`) and get an account, and a
      // session, for an address it never proved and with no password.
      const result = await signup(env, {
        email: body.email, password: body.password, name: body.name, inviteCode: body.inviteCode,
        locale: body.locale || localeFromRequest(request),
      });
      if (result.error) return json({ message: result.error }, 400);
      await signedIn(env, request, result.token, result.userId, "password");
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
      await signedIn(env, request, result.token, result.userId, "email_code");
      return json(result);
    }

    // Sign in with Apple, from the phone app (src/apple.js). Same budget as
    // the other ways of trading a credential for a session.
    if (url.pathname === "/auth/apple" && request.method === "POST") {
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const body = await request.json().catch(() => ({}));
      const { signInWithApple } = await import("./apple.js");
      const result = await signInWithApple(env, {
        identityToken: body.identityToken,
        nonce: body.nonce,
        name: body.name,
        inviteCode: typeof body.inviteCode === "string" ? body.inviteCode : undefined,
        locale: body.locale || localeFromRequest(request),
        authorizationCode: typeof body.authorizationCode === "string" ? body.authorizationCode : undefined,
      }, { after: ctx && typeof ctx.waitUntil === "function" ? (work) => after(ctx, work) : undefined });
      if (result.error) return json({ message: result.error }, result.status || 400);
      await signedIn(env, request, result.token, result.userId, "apple");
      return json(result);
    }

    if (url.pathname === "/auth/login" && request.method === "POST") {
      const limited = await enforce(env, request, "oauth/token");
      if (limited) return limited;
      const body = await request.json().catch(() => ({}));
      const result = await login(env, { email: body.email, password: body.password, inviteCode: body.inviteCode });
      if (result.error) return json({ message: result.error }, result.status || 401);
      await signedIn(env, request, result.token, result.userId, "password");
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
      { const held = await policyDenial(env, session, body.orgId); if (held) return json(held.body, held.status); }
      const result = await createInvite(env, { orgId: body.orgId, createdBy: session.github_id, role: body.role, uses: body.uses, channels: body.channels });
      if (result.error) return json({ message: result.error }, 400);
      await audit(env, request, { orgId: body.orgId, action: "invite.created", actor: await actorOf(env, session), entity: { type: "invite", id: result.ref, name: result.role }, details: { role: result.role, maxUses: result.maxUses, expiresAt: result.expiresAt, channels: result.channels } });
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
      con…27627 tokens truncated… }, 400);

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
      if (await hiddenCard(env, request, orgId, card)) return json({ message: "no such card" }, 404);
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const userKey = request.headers.get("x-ai-key") || undefined;
      const provider = await providerFor(env, orgId, userKey);
      if (!provider) return json({ message: "Your AI has no model to answer with on this deployment." }, 503);
      const allowance = await allowanceFor(env, orgId, { githubId: String(session.github_id), userKey });
      if (!allowance.allowed) {
        if (allowance.workspaceBudgetExceeded || allowance.workspaceBudgetCheckUnavailable) return json({ message: allowance.message, workspaceBudgetExceeded: Boolean(allowance.workspaceBudgetExceeded), workspaceBudgetCheckUnavailable: Boolean(allowance.workspaceBudgetCheckUnavailable) }, 429);
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
        // Only what the asker could open themselves: a guest's own cards, a
        // private channel's to its members.
        const access = await cardAccess(env, request, orgId);
        const [decisionsHit, recentHit, notionHit, githubHit, playbookHit, talkHit] = await Promise.all([
          searchDecisions(env.DB, orgId, terms, { viewer: access.login || null, access }),
          recentDecisions(env.DB, orgId, { limit: 8, access }),
          available.notion ? searchNotion(env, session.github_id, terms).catch((err) => { console.error("notion search failed", err?.message || err); return []; }) : [],
          available.github ? searchGithubIssues(session, orgId, terms, env).catch((err) => { console.error("github search failed", err?.message || err); return []; }) : [],
          relevantMemories(env.DB, orgId, `${card.title || ""} ${question}`),
          // What the card's channel has been saying: the conversation the
          // decision came out of is often the answer.
          card.business ? recentBusinessTalk(env.DB, orgId, [card.business], { limit: 12 }).catch(() => []) : [],
        ]);
        const visible = (h) => mayReadCard({ recipientUserID: h.recipient, senderUserID: h.sender, business: h.business }, access);
        talk = card.business && mayRead(`b:${card.business}`, access) ? talkHit : [];
        playbook = access.guest ? [] : playbookHit;
        related = decisionsHit.filter(visible);
        recent = recentHit.filter(visible);
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
        if (allowance.workspaceBudgetExceeded || allowance.workspaceBudgetCheckUnavailable) return json({ message: allowance.message, workspaceBudgetExceeded: Boolean(allowance.workspaceBudgetExceeded), workspaceBudgetCheckUnavailable: Boolean(allowance.workspaceBudgetCheckUnavailable) }, 429);
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
      const item = await ingestedItemForCard(env.DB, cardId, session.github_id, orgId);
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
      const access = await cardAccess(env, request, orgId);
      const found = q ? await searchDecisions(env.DB, orgId, q, { limit: 20, viewer: access.login || null, access }) : [];
      const hits = found.filter((h) => mayReadCard({ recipientUserID: h.recipient, senderUserID: h.sender, business: h.business }, access)).slice(0, 12);
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
      if (await hiddenCard(env, request, orgId, card)) return json({ message: "no such card" }, 404);
      if (!needsLocalizing(card, locale)) {
        return json({ localized: card.localized?.[locale] || null, already: true });
      }
      const provider = await providerFor(env, orgId, request.headers.get("x-ai-key") || undefined);
      if (!provider) return json({ message: "Your AI has no model to translate with on this deployment." }, 503);
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const allowance = await allowanceFor(env, orgId, { githubId: String(session.github_id), userKey: request.headers.get("x-ai-key") || undefined });
      if (!allowance.allowed) return json({ message: allowance.message || "You have used today's AI answers.", quotaExceeded: true, ...(allowance.workspaceBudgetExceeded ? { workspaceBudgetExceeded: true } : {}), ...(allowance.workspaceBudgetCheckUnavailable ? { workspaceBudgetCheckUnavailable: true } : {}) }, 429);
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
        if (await hiddenCard(env, request, orgId, card)) return json({ message: "no such card" }, 404);
        return json({
          comments: await listComments(env.DB, orgId, cardId),
          reactions: await listReactions(env.DB, orgId, cardId, user.login),
          available: REACTIONS,
          maxChars: MAX_COMMENT_CHARS,
        });
      }
      if (await hiddenCard(env, request, orgId, await getCard(env.DB, orgId, cardId))) return json({ message: "no such card" }, 404);
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
      if (await hiddenCard(env, request, orgId, await getCard(env.DB, orgId, cardId))) return json({ message: "no such card" }, 404);
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
      if (await hiddenCard(env, request, orgId, card)) return json({ message: "no such card" }, 404);
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
      // A card gone leaves its history to the members, not to a guest.
      { const card = await getCard(env.DB, orgId, cardId);
        if (card ? await hiddenCard(env, request, orgId, card) : (await cardAccess(env, request, orgId)).guest) return json({ message: "no such card" }, 404); }
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
      const guest = await guestRefused(env, request, orgId);
      if (guest) return guest;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const includeAIByMember = Boolean(session && membershipIsOurs(orgId) && await allowed(env.DB, orgId, session.github_id, "workspace.ai_settings"));
      return json(await orgMetrics(env.DB, orgId, { days: url.searchParams.get("days"), aiDays: url.searchParams.get("aiDays"), includeAIByMember }));
    }

    // Real cards, with their verdicts, in the shape the eval harness reads.
    if (url.pathname === "/eval/export" && request.method === "GET") {
      const orgId = url.searchParams.get("orgId") || "";
      if (!orgId) return json({ message: "orgId is required" }, 400);
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const guest = await guestRefused(env, request, orgId);
      if (guest) return guest;
      return json({ entries: await exportGolden(env.DB, orgId, { limit: url.searchParams.get("limit") }) });
    }

    const orgEventsMatch = url.pathname.match(/^\/orgs\/([^/]+)\/([^/]+)\/events$/);
    if (orgEventsMatch && request.method === "GET") {
      const [, owner, repo] = orgEventsMatch;
      const orgId = `${owner}/${repo}`;
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      { const guest = await guestRefused(env, request, orgId); if (guest) return guest; }
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
      // The same one workspace their connected apps pull into.
      const orgId = await ingestWorkspaceOf(env.DB, githubId);
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
      // No call made: its place in the day goes back (gate.js).
      await allowance.release();
      await settleUsage(env.DB, provider, { orgId, githubId });

      let cardId = null;
      if (result.card) {
        cardId = crypto.randomUUID();
        const filing = await allowanceFor(env, orgId, { githubId: String(githubId) });
        const business = await fileCardUnderBusiness(env, {
          orgId, provider, githubId,
          card: { ...result.card, sourceDetail: `${message.from} · ${message.subject}` },
          allowance: filing,
        });
        await filing.release();
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

/// D1's refusal once the account is past its free tier's daily row reads or
/// writes ("Your account has exceeded D1's free tier daily row read limit…").
export function isDatabaseLimit(err) {
  return /exceeded D1's free tier daily row/i.test(String(err?.message || err || ""));
}

/// Where to play a card's video from, for someone who may read the card:
/// a signed address on the media origin when it is on, else the address
/// the card was saved with. Only the video the card itself names.
///
/// A video belongs to the first card it came on. Another card naming the
/// same video — anyone can paste an address into a new card — plays it only
/// for someone who may also read that first one, so a reader who lost a
/// private channel does not get the channel's videos back through a card of
/// their own.
async function cardVideoUrl(env, { orgId, login, cardId }) {
  const card = await getCard(env.DB, orgId, cardId);
  const access = await accessFor(env.DB, orgId, login);
  if (!card?.videoURL || !mayReadCard(card, access)) return null;
  const m = /\/media\/([0-9a-fA-F-]{36})(?:\?o=([^&#]+))?/.exec(String(card.videoURL));
  if (!m) return { url: card.videoURL, expiresAt: null };
  const stored = m[2] ? decodeURIComponent(m[2]) : null;
  if (stored && stored !== orgId) return null;
  const first = await env.DB.prepare(
    "SELECT card_id FROM cards WHERE org_id = ?1 AND instr(lower(json_extract(data, '$.videoURL')), ?2) > 0 ORDER BY rowid LIMIT 1"
  ).bind(orgId, `/media/${m[1].toLowerCase()}`).first();
  if (first?.card_id && first.card_id !== cardId && !mayReadCard(await getCard(env.DB, orgId, first.card_id), access)) return null;
  if (mediaOriginOn(env)) {
    const signed = await signVideoUrl(env, { orgId: stored, id: m[1] });
    if (signed) return signed;
  }
  // Without the media origin, an address the API signs, so the bare one can
  // be retired either way (MEDIA_LEGACY_VIDEO = "off").
  const { signedQuery } = await import("./addressSigning.js");
  const signed = await signedQuery(env, "v1", stored || "", m[1]);
  if (!signed) return { url: card.videoURL, expiresAt: null };
  const where = new URL(card.videoURL);
  where.search = `${stored ? `o=${encodeURIComponent(stored)}&` : ""}${signed.query}`;
  return { url: where.toString(), expiresAt: signed.until * 1000 };
}

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
