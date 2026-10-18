// Telling the room about cards that were written outside it.
//
// A connector sync runs in the Worker and writes straight to D1. The sockets
// live in the Durable Object, which knows nothing about that write — so until
// this existed, a card triaged from your inbox did not appear until something
// dropped your connection and the app pulled a fresh snapshot. The push
// notification went out immediately, which made it worse: you were told a
// decision was waiting, opened the app, and it was not there.
//
// The DO is reachable only through its binding. The public handler forwards a
// request to the stub only when it carries `Upgrade: websocket`, so this path
// cannot be reached from the internet; the DO checks the header again anyway,
// because "unreachable" is a property of code someone can change.
export const ANNOUNCE_PATH = "/internal/announce";
export const EVICT_PATH = "/internal/evict";
export const EVENTS_PATH = "/internal/events";

// Any already-built AG-UI events for one workspace's open sockets — a context
// saved over REST, which the relay would otherwise have broadcast itself.
export async function announceEvents(env, orgId, events) {
  if (!events?.length) return { announced: 0 };
  if (!env.ORG_RELAY) return { announced: 0, skipped: "no relay binding" };
  try {
    const stub = env.ORG_RELAY.get(env.ORG_RELAY.idFromName(orgId));
    await stub.fetch(`https://relay.internal${EVENTS_PATH}?orgId=${encodeURIComponent(orgId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
    return { announced: events.length };
  } catch (err) {
    console.error("event announce failed", err?.message || err);
    return { announced: 0, error: err?.message || String(err) };
  }
}

/// Events for named people in one workspace, each their own: `[{ to: login, event }]`.
export async function announceTo(env, orgId, deliveries) {
  if (!deliveries?.length || !env.ORG_RELAY) return { announced: 0 };
  try {
    const stub = env.ORG_RELAY.get(env.ORG_RELAY.idFromName(orgId));
    await stub.fetch(`https://relay.internal${EVENTS_PATH}?orgId=${encodeURIComponent(orgId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveries }),
    });
    return { announced: deliveries.length };
  } catch (err) {
    console.error("targeted announce failed", err?.message || err);
    return { announced: 0, error: true };
  }
}

export async function announceCards(env, orgId, cards, { isNew = true } = {}) {
  if (!cards?.length) return { announced: 0 };
  // No relay binding, nowhere to announce. The cards are stored either way;
  // this is the difference between "seen now" and "seen on reconnect".
  if (!env.ORG_RELAY) return { announced: 0, skipped: "no relay binding" };
  try {
    const stub = env.ORG_RELAY.get(env.ORG_RELAY.idFromName(orgId));
    await stub.fetch(`https://relay.internal${ANNOUNCE_PATH}?orgId=${encodeURIComponent(orgId)}${isNew ? "" : "&kind=updated"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cards }),
    });
    return { announced: cards.length };
  } catch (err) {
    // The cards are already stored. Failing to announce them means they appear
    // on the next reconnect rather than now — worth a log, never worth failing
    // the sync that produced them.
    console.error("announce failed", orgId, err?.message || err);
    return { announced: 0, error: true };
  }
}


/// Take somebody out of the room they are already standing in.
///
/// `att.authed` is written once, at join, and never looked at again — which
/// was right while nothing could revoke a membership. Now that a workspace
/// can, a socket opened a moment earlier is the whole of someone's continued
/// access: every card broadcast in that org keeps reaching them, and they can
/// keep acting, until something else happens to drop the connection.
///
/// Keyed by login, because that is what the relay stamps on a socket — the
/// membership row's `user_github_id` names the same person and matches nothing
/// in this object.
export async function evictMember(env, orgId, login) {
  if (!login || !env.ORG_RELAY) return { evicted: 0 };
  try {
    const stub = env.ORG_RELAY.get(env.ORG_RELAY.idFromName(orgId));
    const res = await stub.fetch(`https://relay.internal${EVICT_PATH}?orgId=${encodeURIComponent(orgId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login }),
    });
    return await res.json();
  } catch (err) {
    // The membership row is already gone, so they cannot join again. Failing
    // here means the socket they are holding outlives the removal — worth a
    // log, never worth failing the removal that produced it.
    console.error("evict failed", orgId, err?.message || err);
    return { evicted: 0, error: true };
  }
}

/// Take somebody out of one private channel's Jam, when they are taken out of
/// the channel: the socket that joined it stays in the Jam otherwise, still
/// hearing it and still introduced to whoever joins next.
export async function evictFromJam(env, orgId, login, channel) {
  if (!login || !channel || !env.ORG_RELAY) return { evicted: 0 };
  try {
    const stub = env.ORG_RELAY.get(env.ORG_RELAY.idFromName(orgId));
    const res = await stub.fetch(`https://relay.internal${EVICT_PATH}?orgId=${encodeURIComponent(orgId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login, channel }),
    });
    return await res.json();
  } catch (err) {
    console.error("jam evict failed", orgId, err?.message || err);
    return { evicted: 0, error: true };
  }
}

/// Close the sockets these sessions are holding, once the sessions are
/// signed out: in `orgId` only, when they were signed out of one workspace,
/// or everywhere they were used. Keyed by the session's row (its hash), the
/// one thing a socket carries that names the device rather than the person,
/// so the account's other devices stay where they are.
///
/// Where a session was used is `session_workspaces`, written as it joins a
/// room and kept after the session itself is deleted.
export async function evictSessions(env, tokens, { orgId = null } = {}) {
  const list = [...new Set((tokens || []).filter(Boolean))];
  if (!list.length || !env.ORG_RELAY) return { evicted: 0 };
  let orgs = orgId ? [orgId] : [];
  if (!orgId) {
    const seen = new Set();
    for (let i = 0; i < list.length; i += 50) {
      const part = list.slice(i, i + 50);
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT org_id FROM session_workspaces WHERE token IN (${part.map((_, n) => `?${n + 1}`).join(", ")})`
      ).bind(...part).all().catch(() => ({ results: [] }));
      for (const r of results || []) seen.add(r.org_id);
    }
    orgs = [...seen];
  }
  let evicted = 0;
  for (const org of orgs) {
    try {
      const stub = env.ORG_RELAY.get(env.ORG_RELAY.idFromName(org));
      const res = await stub.fetch(`https://relay.internal${EVICT_PATH}?orgId=${encodeURIComponent(org)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessions: list, here: Boolean(orgId) }),
      });
      evicted += Number((await res.json())?.evicted) || 0;
    } catch (err) {
      // The sessions are already signed out, so they cannot join again, and
      // the relay checks the session a socket holds again as it goes.
      console.error("session evict failed", org, err?.message || err);
    }
  }
  return { evicted };
}
