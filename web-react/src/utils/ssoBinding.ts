// A single sign-on started here comes back here. The page that sends someone
// to their company's identity provider keeps a secret, and hands the Worker
// only its hash; the one-time code the sign-in comes back with is traded
// for a session only with that secret. A link to a finished sign-in that
// this browser did not start — someone else's, sent to be opened — is
// refused, instead of quietly swapping whoever is signed in here for that
// account.

const KEY = 'sso.pending'
// As long as the Worker keeps a started sign-in (sso.js STATE_MINUTES).
const LIFETIME_MS = 10 * 60_000

interface Pending { verifier: string; at: number }

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/// A new secret for a sign-in about to start, kept in this browser; what to
/// send as `bind` on /sso/start.
export async function bindSsoStart(storage: Storage = localStorage, now = Date.now()): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  storage.setItem(KEY, JSON.stringify({ verifier, at: now } satisfies Pending))
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

/// The address that starts a sign-in (`/sso/start?…`), bound to this browser.
export async function boundSsoStart(base: string, start: string, storage: Storage = localStorage): Promise<string> {
  const bind = await bindSsoStart(storage)
  return `${base}${start}${start.includes('?') ? '&' : '?'}bind=${bind}`
}

/// The secret of the sign-in this browser started, once: null when it
/// started none, or too long ago to still be finishing.
export function takeSsoVerifier(storage: Storage = localStorage, now = Date.now()): string | null {
  let pending: Pending | null = null
  try {
    pending = JSON.parse(storage.getItem(KEY) || 'null') as Pending | null
    storage.removeItem(KEY)
  } catch { return null }
  if (!pending || typeof pending.verifier !== 'string' || !pending.verifier) return null
  return now - Number(pending.at) <= LIFETIME_MS ? pending.verifier : null
}
