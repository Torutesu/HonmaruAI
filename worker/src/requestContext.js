// What a request carries that code far from the handler needs to know —
// today, the address it came from, for the workspace's allowed networks
// (governance.js). Set once where every request enters (index.js), read
// where every workspace request is admitted (policy.js), so no route can
// forget it.

import { AsyncLocalStorage } from "node:async_hooks";

export const requestContext = new AsyncLocalStorage();

/// The caller's address, or null outside a request (a cron, a test calling
/// a function directly).
export function currentIp() {
  return requestContext.getStore()?.ip || null;
}

export function currentOrigin() {
  return requestContext.getStore()?.origin || null;
}

/// A session read once per request, not once per helper that needs it
/// (#964): route helpers each called getSession, so one request read the
/// same row two or three times. Kept only in this request's store, keyed by
/// database and token, and dropped by forgetRequestSessions() wherever a
/// request changes a session, so nothing it wrote is read back stale.
export function requestSessionCache(db) {
  const store = requestContext.getStore();
  if (!store) return null;
  if (!store.sessions) store.sessions = new WeakMap();
  let byToken = store.sessions.get(db);
  if (!byToken) { byToken = new Map(); store.sessions.set(db, byToken); }
  return byToken;
}

export function forgetRequestSessions() {
  const store = requestContext.getStore();
  if (store) store.sessions = new WeakMap();
}
