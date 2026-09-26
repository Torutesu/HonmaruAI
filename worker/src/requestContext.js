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
