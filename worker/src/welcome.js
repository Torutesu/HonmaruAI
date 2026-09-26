import { postMessage } from "./channels.js";
import { getUserByGithubId } from "./db.js";
import { loadCopy } from "./copy.js";
import { serverText } from "./serverCopy.js";
import { isPrivate, addMembers, isGuestLogin } from "./access.js";

// Somebody new — a person who took an invitation, or an agent that opened
// its link — said in the channels the invitation named, by the AI, in the
// language of whoever invited them.

export async function introduce(env, { orgId, channels, githubId = null, agentName = null, invitedBy }) {
  if (!Array.isArray(channels) || !channels.length) return 0;
  const inviter = await getUserByGithubId(env.DB, invitedBy).catch(() => null);
  const locale = await loadCopy(env, inviter?.locale || "en", { orgId });
  let line;
  if (agentName) {
    line = serverText(locale, "invite.agentJoined", { name: agentName, by: inviter?.name || inviter?.login || "" });
  } else {
    const person = await getUserByGithubId(env.DB, githubId).catch(() => null);
    line = serverText(locale, "invite.joined", { name: person?.name || serverText(locale, "invite.someone") });
  }
  const { broadcastStored } = await import("./channelRoutes.js");
  // A private channel the invitation named takes the newcomer in. (An agent
  // acts as the person who invited it, who is already there.)
  const newcomer = githubId ? await getUserByGithubId(env.DB, githubId).catch(() => null) : null;
  // A guest is let into every channel the invitation named, public ones
  // too: those are the only channels a guest sees.
  const guest = newcomer?.login ? await isGuestLogin(env.DB, orgId, newcomer.login) : false;
  let said = 0;
  for (const slug of channels.slice(0, 50)) {
    if (newcomer?.login && (guest || await isPrivate(env.DB, orgId, slug))) {
      await addMembers(env.DB, { orgId, key: `b:${slug}`, logins: [newcomer.login], addedBy: inviter?.login || null });
    }
    const out = await postMessage(env.DB, { orgId, key: `b:${slug}`, authorLogin: null, body: line, kind: "ai" });
    if (!out.row) continue;
    said += 1;
    await broadcastStored(env, orgId, `b:${slug}`, out.row).catch(() => {});
  }
  return said;
}
