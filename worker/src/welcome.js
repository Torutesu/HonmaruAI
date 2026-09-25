import { postMessage } from "./channels.js";
import { getUserByGithubId } from "./db.js";
import { loadCopy } from "./copy.js";
import { serverText } from "./serverCopy.js";

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
  let said = 0;
  for (const slug of channels.slice(0, 50)) {
    const out = await postMessage(env.DB, { orgId, key: `b:${slug}`, authorLogin: null, body: line, kind: "ai" });
    if (!out.row) continue;
    said += 1;
    await broadcastStored(env, orgId, `b:${slug}`, out.row).catch(() => {});
  }
  return said;
}
