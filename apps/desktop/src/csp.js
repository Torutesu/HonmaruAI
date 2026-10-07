// The Content-Security-Policy the desktop app adds to the web app's own
// pages (docs/architecture/discord-model-platform-plan.md §11.4: strict CSP).
//
// The web app is served without one, and a browser tab gets by with the
// browser's own defences. Inside the desktop app the shell adds it, so a
// script injected into a message can neither run nor phone home. It is added
// beside any policy the server sends — a page then has to satisfy both — so
// it only ever narrows what is allowed.
//
// Pure: no Electron here (test/csp.test.js).

/// The one inline script in web-react/index.html: it applies the chosen
/// light or dark theme before the app's own script loads, so a dark choice
/// does not open on a white flash. A CSP allows an inline script by the hash
/// of its exact text, so changing that script means changing this hash —
/// test/csp.test.js reads index.html and fails until they agree.
export const INLINE_SCRIPT_HASHES = ['sha256-ZSOmNCOL3UyoUvUboFoN0uT1gY4hkv1Ljc7lCwv+8pY=']

/// Where the web app embeds a player for a YouTube link (MessageParts.tsx).
const FRAME_ORIGINS = ['https://www.youtube-nocookie.com']

/// Where files are served from (worker/wrangler.media.toml): pictures and
/// video in a message are fetched from there, not from the API.
export const MEDIA_ORIGINS = ['https://media.honmaruai.com']

/// The socket's address for an API origin: the relay is the same host over
/// wss (ws for a local dev server).
const socketOrigin = (origin) => origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')

/// The policy for the app's pages, as one header value.
///
/// - Scripts: the app's own files and the theme script, by hash. No eval, no
///   other inline script, nothing from another site.
/// - Styles: the app's own stylesheets. (React's `style={…}` props are set
///   through the DOM, which a CSP does not restrict.)
/// - Connections: the app, the API over https, and the relay over wss.
/// - Images: the app, the API, data: and blob: (pasted pictures, previews),
///   and any https site — people's avatars come from GitHub and Google, and a
///   link's preview shows that site's own picture. An image cannot run code.
/// - Media: the app, the API and blob:. Frames: the YouTube player only.
/// - No plugins, no <base> elsewhere, forms only to the app or the API, and
///   no other site may frame the app.
///
/// `dev` (an unpackaged app pointed at the Vite dev server) adds what Vite's
/// hot reload needs: inline scripts and styles, and http/ws on localhost.
export function buildCsp({ apiOrigins = [], mediaOrigins = MEDIA_ORIGINS, scriptHashes = INLINE_SCRIPT_HASHES, dev = false }) {
  const api = [...new Set(apiOrigins)]
  const media = [...new Set(mediaOrigins)]
  const hashes = scriptHashes.map((hash) => `'${hash}'`)
  const local = dev ? ['http://localhost:*', 'ws://localhost:*', 'http://127.0.0.1:*', 'ws://127.0.0.1:*'] : []
  const directives = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", ...hashes, ...(dev ? ["'unsafe-inline'"] : [])]],
    ['style-src', ["'self'", ...(dev ? ["'unsafe-inline'"] : [])]],
    ['connect-src', ["'self'", ...api, ...api.map(socketOrigin), ...local]],
    ['img-src', ["'self'", ...api, 'data:', 'blob:', 'https:', ...local]],
    ['media-src', ["'self'", ...api, ...media, 'blob:', ...local]],
    ['font-src', ["'self'", 'data:']],
    ['frame-src', [...FRAME_ORIGINS]],
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'", ...api]],
    ['frame-ancestors', ["'none'"]],
  ]
  return directives.map(([name, sources]) => `${name} ${[...new Set(sources)].join(' ')}`).join('; ')
}

/// Response headers with the policy added, for a response from the app's own
/// origin; any other response's headers come back as they were. A policy the
/// server already sent stays: both are sent, and both are enforced.
export function withCsp(responseHeaders, url, { appOrigin, policy }) {
  let origin = null
  try { origin = new URL(url).origin } catch { /* not a URL */ }
  if (origin !== appOrigin) return responseHeaders
  const headers = { ...(responseHeaders || {}) }
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-security-policy') || 'Content-Security-Policy'
  const existing = headers[key] === undefined ? [] : [].concat(headers[key])
  headers[key] = [...existing, policy]
  return headers
}
