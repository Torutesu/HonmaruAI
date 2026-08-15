// One structured line per request.
//
// Until this existed, the only way to answer "why did this user's routing fail
// at 3pm" was to guess. `wrangler tail` shows console output, and console output
// that is a sentence cannot be filtered; JSON can.
//
// The rule about what goes in a line is short and absolute: never a token,
// never a body, never a card's contents. A log that leaks the thing the product
// exists to protect is worse than no log. Everything here is either an id, a
// route, or a number.

const REDACT = /(?:gho_|ghp_|sk-|Bearer\s+)\S+/gi;

export function safe(message) {
  return String(message ?? "").replace(REDACT, "[redacted]").slice(0, 500);
}

export function logJSON(fields) {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
  } catch {
    // A logger that can throw is a logger that can take the request with it.
  }
}

/// Routes collapse ids so lines group: two people reading two orgs' histories
/// are the same route, and a per-org route name makes that impossible to see.
export function routeLabel(method, pathname) {
  const collapsed = pathname
    .replace(/^\/orgs\/[^/]+\/[^/]+/, "/orgs/:owner/:repo")
    .replace(/\/cards\/[^/]+/, "/cards/:id")
    .replace(/^\/media\/[^/]+$/, "/media/:id")
    .replace(/^\/connectors\/[^/]+\//, "/connectors/:id/");
  return `${method} ${collapsed}`;
}
