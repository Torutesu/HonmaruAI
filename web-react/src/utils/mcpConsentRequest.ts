const KEY = 'honmaru:mcp-consent'
type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
function sessionStore(): SessionStore | undefined {
  try { return globalThis.sessionStorage } catch { return undefined }
}
export function pendingMcpRequest(hash: string, storage = sessionStore()): string {
  const match = hash.match(/^#\/mcp\/consent\/(hmreq_[a-f0-9]{64})$/)
  if (match) {
    try { storage?.setItem(KEY, match[1]) } catch { /* The current URL still carries the request. */ }
    return match[1]
  }
  try {
    const saved = storage?.getItem(KEY) || ''
    return /^hmreq_[a-f0-9]{64}$/.test(saved) ? saved : ''
  } catch { return '' }
}
export function clearMcpRequest(storage = sessionStore()) {
  try { storage?.removeItem(KEY) } catch { /* No persisted request is available. */ }
}
