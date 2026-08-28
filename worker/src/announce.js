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

export async function announceCards(env, orgId, cards) {
  if (!cards?.length) return { announced: 0 };
  // No relay binding, nowhere to announce. The cards are stored either way;
  // this is the difference between "seen now" and "seen on reconnect".
  if (!env.ORG_RELAY) return { announced: 0, skipped: "no relay binding" };
  try {
    const stub = env.ORG_RELAY.get(env.ORG_RELAY.idFromName(orgId));
    await stub.fetch(`https://relay.internal${ANNOUNCE_PATH}?orgId=${encodeURIComponent(orgId)}`, {
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
