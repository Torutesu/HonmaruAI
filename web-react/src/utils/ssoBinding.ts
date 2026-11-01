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

interface Pending { verifier: string; at: number; bind?: string; owner?: string }

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const identity = (storage: Storage) => JSON.stringify([storage.getItem('sessionToken'),storage.getItem('userId'),storage.getItem('host'),storage.getItem('orgId')])
const hash = async (value: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))))

/// A new secret for a sign-in about to start, kept in this browser; what to
/// send as `bind` on /sso/start.
export async function bindSsoStart(storage: Storage = localStorage, now = Date.now(), current: () => boolean = () => true): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const before=identity(storage)
  const [bind,owner]=await Promise.all([hash(verifier),hash(before)])
  if(!current() || identity(storage)!==before)throw new Error('Session changed before SSO started.')
  storage.setItem(KEY, JSON.stringify({ verifier, at: now, bind, owner } satisfies Pending))
  return bind
}

/// The address that starts a sign-in (`/sso/start?…`), bound to this browser.
export async function boundSsoStart(base: string, start: string, storage: Storage = localStorage, current: () => boolean = () => true): Promise<string> {
  const bind = await bindSsoStart(storage,Date.now(),current)
  return `${base}${start}${start.includes('?') ? '&' : '?'}bind=${bind}`
}

// A stale async start may finish after a newer one. Remove only its own
// verifier; never erase the binding for a different SSO attempt.
export function discardSsoStart(href: string, storage: Storage = localStorage): void {
  try {
    const bind=new URL(href).searchParams.get('bind')
    const pending=JSON.parse(storage.getItem(KEY) || 'null') as Pending | null
    if(bind && pending?.bind===bind)storage.removeItem(KEY)
  } catch { /* an unreadable entry cannot be attributed safely */ }
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

// A redirect may return after another tab has signed in. The verifier is
// bound to a digest of the starting session rather than storing its token.
export async function takeSsoVerifierForCurrentSession(storage: Storage = localStorage, now = Date.now(), current: () => boolean = () => true): Promise<string | null> {
  try {
    const raw=storage.getItem(KEY)
    const pending=JSON.parse(raw || 'null') as Pending | null
    if(!pending || !pending.owner || typeof pending.verifier!=='string' || !pending.verifier || now-Number(pending.at)>LIFETIME_MS)return null
    const before=identity(storage), owner=await hash(before)
    if(!current() || storage.getItem(KEY)!==raw || identity(storage)!==before || owner!==pending.owner)return null
    storage.removeItem(KEY)
    return pending.verifier
  } catch { return null }
}
