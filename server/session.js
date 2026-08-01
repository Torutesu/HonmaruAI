import { randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "ttfw_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OAUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function parseCookies(header) {
  const jar = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    jar[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

export function serializeCookie(name, value, { maxAgeMs, secure = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  parts.push(`Max-Age=${Math.floor((maxAgeMs ?? SESSION_TTL_MS) / 1000)}`);
  return parts.join("; ");
}

export function clearCookie(name, { secure = true } = {}) {
  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function constantTimeEquals(a, b) {
  const bufferA = Buffer.from(String(a || ""));
  const bufferB = Buffer.from(String(b || ""));
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/**
 * Browser sessions. The GitHub access token lives here — server-side — and
 * never reaches JavaScript; the browser only carries an httpOnly cookie.
 */
export function createSessionStore(initial) {
  const sessions =
    initial?.sessions && typeof initial.sessions === "object" ? initial.sessions : {};

  // OAuth state is server-side, single-use and short-lived: the CSRF
  // guarantee comes from the attacker being unable to produce a value we
  // issued. (PKCE is for public clients; the relay is a confidential client
  // holding the client secret, and GitHub OAuth Apps don't support it.)
  const pendingAuth = new Map();

  function prune(now) {
    for (const [id, session] of Object.entries(sessions)) {
      if (now - Date.parse(session.createdAt) > SESSION_TTL_MS) {
        delete sessions[id];
      }
    }
    for (const [state, entry] of pendingAuth.entries()) {
      if (now - entry.createdAt > OAUTH_TTL_MS) pendingAuth.delete(state);
    }
  }

  return {
    cookieName: SESSION_COOKIE,

    serialize() {
      return { sessions };
    },

    beginAuth(now = Date.now()) {
      prune(now);
      const state = randomBytes(24).toString("hex");
      pendingAuth.set(state, { createdAt: now });
      return state;
    },

    // Single-use: consuming a state invalidates it, so a replayed callback fails.
    consumeAuth(state, now = Date.now()) {
      prune(now);
      for (const key of pendingAuth.keys()) {
        if (constantTimeEquals(key, state)) {
          pendingAuth.delete(key);
          return true;
        }
      }
      return false;
    },

    create({ userId, githubToken, githubLogin, repository }, now = Date.now()) {
      prune(now);
      const id = randomBytes(32).toString("hex");
      sessions[id] = {
        userId,
        githubToken,
        githubLogin: githubLogin || null,
        repository: repository || null,
        createdAt: new Date(now).toISOString(),
      };
      return id;
    },

    get(id, now = Date.now()) {
      if (!id) return null;
      const session = sessions[id];
      if (!session) return null;
      if (now - Date.parse(session.createdAt) > SESSION_TTL_MS) {
        delete sessions[id];
        return null;
      }
      return session;
    },

    setRepository(id, repository) {
      const session = sessions[id];
      if (!session) return false;
      session.repository = repository;
      return true;
    },

    destroy(id) {
      if (!id || !sessions[id]) return false;
      delete sessions[id];
      return true;
    },

    fromRequest(req) {
      const id = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
      const session = this.get(id);
      return session ? { id, session } : null;
    },
  };
}

/** Public origin for OAuth redirects: explicit env wins, else the request host. */
export function originFor(req, configured) {
  if (configured) return configured.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim() || (req.socket?.encrypted ? "https" : "http");
  return `${proto}://${req.headers.host}`;
}
