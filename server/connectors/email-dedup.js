// Per-process dedup for inbound emails, keyed by the hash parseEmailMessage
// already computes from (messageId, from). In-memory only — matches the
// relay's overall storage model (orgStores is in-memory too), resets on
// restart. Entries expire so memory doesn't grow unbounded on a long-lived
// process; a day is generous for "the same webhook got redelivered."
const TTL_MS = 24 * 60 * 60 * 1000;

const seen = new Map(); // `${orgId}:${hash}` -> expiry (ms epoch)

function prune(nowMs) {
  for (const [key, expiresAt] of seen) {
    if (expiresAt <= nowMs) seen.delete(key);
  }
}

function wasAlreadyIngested(orgId, hash) {
  prune(Date.now());
  return seen.has(`${orgId}:${hash}`);
}

function markIngested(orgId, hash) {
  seen.set(`${orgId}:${hash}`, Date.now() + TTL_MS);
}

export { wasAlreadyIngested, markIngested };
