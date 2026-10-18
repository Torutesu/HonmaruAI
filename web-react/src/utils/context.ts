// "How I work": what the person tells their AI about themselves once, and
// the router reads on every instruction they send — "I run the cafe and the
// hotel; Kenji owns suppliers; anything about the lease is mine".
//
// It lives on the server, per person and per workspace (`/me/context`): the
// same row the phone writes, so a browser and a phone see one answer, and
// what you are in one team is not what you are in another. This browser
// keeps a copy under the workspace's own key, so a send does not wait on a
// fetch — and a copy for one workspace is never read for another.

const KEY = 'senderContext'
export const MAX_CONTEXT_CHARS = 4000
const keyFor = (orgId?: string) => (orgId ? `${KEY}:${orgId}` : KEY)

export function getSenderContext(orgId?: string): string {
  try { return (localStorage.getItem(keyFor(orgId)) || '').slice(0, MAX_CONTEXT_CHARS) } catch { return '' }
}

export function setSenderContext(text: string, orgId?: string): void {
  const clean = text.slice(0, MAX_CONTEXT_CHARS)
  try {
    if (clean.trim()) localStorage.setItem(keyFor(orgId), clean)
    else localStorage.removeItem(keyFor(orgId))
  } catch { /* a browser that keeps nothing keeps nothing */ }
}

/// Whether `sessionToken` is still the session this browser is signed in
/// with. An answer that set out under an account since signed out — or
/// replaced by another, in this tab or another — must not write that
/// account's words where the next one reads them.
function stillSignedIn(sessionToken: string): boolean {
  try { return Boolean(sessionToken) && localStorage.getItem('sessionToken') === sessionToken } catch { return false }
}

/// The server's copy, which is the truth; the local one is refreshed from it.
///
/// With one exception: a local copy the server has never had a word of —
/// written before this existed — is sent up rather than thrown away. Once
/// the server has kept any text, an empty one included, it wins: an empty
/// one is a clear made on this device or another, and the old copy here
/// must not undo it. Null when there is no answer to show: the request failed, the session it
/// was asked under is over, or the local copy was edited while it was on its
/// way (that edit is newer than the answer).
export async function loadSenderContext(httpBase: string, orgId: string, sessionToken: string): Promise<string | null> {
  const before = getSenderContext(orgId)
  try {
    const res = await fetch(`${httpBase}/me/context?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
    if (!res.ok) return null
    const data = await res.json().catch(() => ({}))
    if (!stillSignedIn(sessionToken) || getSenderContext(orgId) !== before) return null
    const text = typeof data.text === 'string' ? data.text : ''
    // An older Worker does not say whether it kept anything; its blank is
    // taken as the clear it may be.
    if (!text.trim() && data.saved === false) {
      const local = getSenderContext(orgId) || legacyContext()
      if (local.trim()) {
        void saveSenderContext(httpBase, orgId, sessionToken, local)
        return local
      }
    }
    setSenderContext(text, orgId)
    return text
  } catch {
    return null
  }
}

/// The one copy this browser kept before it was per workspace. Read once,
/// into the workspace being looked at, and then gone.
function legacyContext(): string {
  try {
    const old = localStorage.getItem(KEY) || ''
    if (old) localStorage.removeItem(KEY)
    return old.slice(0, MAX_CONTEXT_CHARS)
  } catch { return '' }
}

export async function saveSenderContext(httpBase: string, orgId: string, sessionToken: string, text: string): Promise<boolean> {
  // Saved on the way out of a profile after its account signed out, the
  // words still go to that account's own row, but not into this browser.
  if (stillSignedIn(sessionToken)) setSenderContext(text, orgId)
  try {
    const res = await fetch(`${httpBase}/me/context`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify({ orgId, text: text.slice(0, MAX_CONTEXT_CHARS) }),
    })
    return res.ok
  } catch {
    return false
  }
}
