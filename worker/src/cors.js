// Which web pages may read this API's answers.
//
// Every module answered `access-control-allow-origin: *`: any site a person
// had open could call the API from their browser and read the answer, given
// a token. The token is not in a cookie, so a site cannot borrow one — but a
// page that has one (stolen, or planted by a script) could use it from
// anybody's browser, and nothing said which pages are ours.
//
// Rather than each module deciding, the answer is settled once, on the way
// out (index.js): a page of ours is named back; any other page is answered
// with no CORS header, so its browser keeps the answer from it. The native
// apps send no Origin and are unaffected. Routes meant for any page — files
// and media fetched by address, agents and servers that bring their own
// token, public documents — keep `*`.

/// The app's own addresses, besides APP_WEB_URL and CORS_ORIGINS.
const DEFAULT_ORIGINS = ["https://app.honmaruai.com", "https://honmaru-web.pages.dev"];
/// Preview deployments of the web app: <hash>.honmaru-web.pages.dev.
const PREVIEW = /^https:\/\/[a-z0-9-]+\.honmaru-web\.pages\.dev$/;

/// Paths any page may read: fetched by address, or by agents and servers
/// bringing their own credentials, or public.
const OPEN = /^\/(?:mcp$|files\/|media\/|\.well-known\/|admin\/v1\/|scim\/|webhooks\/|health$|agents\/join\/|app\/ios$|ResourceTypes|Schemas|ServiceProviderConfig|audit\/public-key$)/;

const originOf = (raw) => {
  try { return new URL(String(raw)).origin; } catch { return null; }
};

/// The origins named in the env, and the app's own.
export function allowedOrigins(env) {
  const out = new Set(DEFAULT_ORIGINS);
  const app = env?.APP_WEB_URL && originOf(env.APP_WEB_URL);
  if (app) out.add(app);
  for (const raw of String(env?.CORS_ORIGINS || "").split(/[\s,]+/)) {
    const o = raw && originOf(raw);
    if (o) out.add(o);
  }
  return out;
}

const LOCAL = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

/// Whether a page at `origin` may read what `url` answers.
export function originAllowed(origin, url, env) {
  if (!origin) return true;
  if (origin === url.origin) return true;
  if (allowedOrigins(env).has(origin) || PREVIEW.test(origin)) return true;
  // A Worker running on this machine serves the app running on this machine.
  return LOCAL.test(origin) && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/// Settle the CORS headers of a response on its way out. `headers` is the
/// response's, already copied, and is changed in place.
export function settleCors(request, url, env, headers) {
  if (String(env?.CORS_ENFORCE || "").toLowerCase() === "off") return;
  if (!headers.has("access-control-allow-origin")) return;
  if (OPEN.test(url.pathname)) return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (originAllowed(origin, url, env)) {
    headers.set("access-control-allow-origin", origin);
    headers.append("vary", "Origin");
    return;
  }
  for (const name of ["access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods", "access-control-expose-headers", "access-control-allow-credentials", "access-control-max-age"]) {
    headers.delete(name);
  }
}
