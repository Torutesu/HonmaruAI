// "How I work": what the person tells their AI about themselves once, and
// the router reads on every instruction they send — "I run the cafe and the
// hotel; Kenji owns suppliers; anything about the lease is mine". Kept in
// this browser, the way the phone keeps it on the device: it is context for
// the person's own sends, not a profile the team reads.

const KEY = 'senderContext'
export const MAX_CONTEXT_CHARS = 4000

export function getSenderContext(): string {
  try { return (localStorage.getItem(KEY) || '').slice(0, MAX_CONTEXT_CHARS) } catch { return '' }
}

export function setSenderContext(text: string): void {
  const clean = text.slice(0, MAX_CONTEXT_CHARS)
  try {
    if (clean.trim()) localStorage.setItem(KEY, clean)
    else localStorage.removeItem(KEY)
  } catch { /* a browser that keeps nothing keeps nothing */ }
}
