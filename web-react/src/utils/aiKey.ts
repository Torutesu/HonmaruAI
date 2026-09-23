// Your own model key. Sent only with your own requests, as the phone does
// from its Keychain; kept in this browser and nowhere on our side. With one,
// the Worker routes, answers, drafts and translates on your key and outside
// the daily allowance.

const KEY = 'aiKey'

export function getAIKey(): string {
  try { return (localStorage.getItem(KEY) || '').trim() } catch { return '' }
}

export function setAIKey(key: string): void {
  const clean = key.trim().slice(0, 200)
  try {
    if (clean) localStorage.setItem(KEY, clean)
    else localStorage.removeItem(KEY)
  } catch { /* a browser that keeps nothing keeps nothing */ }
}

/// The header to add to a request that may spend a model.
export function aiHeaders(): Record<string, string> {
  const key = getAIKey()
  return key ? { 'x-ai-key': key } : {}
}
