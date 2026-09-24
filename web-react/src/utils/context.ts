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

/// The server's copy, which is the truth; the local one is refreshed from it.
///
/// With one exception: a local copy the server has never seen — written
/// before this existed, or typed and closed before the save landed — is sent
/// up rather than thrown away. The server wins only once it has something.
export async function loadSenderContext(httpBase: string, orgId: string, sessionToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${httpBase}/me/context?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
    if (!res.ok) return null
    const data = await res.json().catch(() => ({}))
    const text = typeof data.text === 'string' ? data.text : ''
    if (!text.trim()) {
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
  setSenderContext(text, orgId)
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
