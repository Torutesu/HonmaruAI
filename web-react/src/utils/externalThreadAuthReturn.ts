import { externalThreadHash, type ExternalThreadAccess } from './externalThreadInvite'

const KEY = 'honmaru.externalThreadAuthReturn'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Accept only the canonical, same-origin route for one exact Thread. */
export function externalThreadAuthReturnPath(hash: string): string | null {
  const match = /^#\/external-thread\/([^/]+)\/([^/]+)$/.exec(hash)
  if (!match) return null
  try {
    const orgId = decodeURIComponent(match[1])
    const rootId = decodeURIComponent(match[2])
    if (!orgId || orgId.length > 200 || !rootId || rootId.length > 200) return null
    const access: ExternalThreadAccess = { orgId, rootId, permission: 'view' }
    return externalThreadHash(access)
  } catch {
    return null
  }
}

/** Keep a tab-local target while the browser visits an identity provider. */
export function rememberExternalThreadAuthReturn(storage: StorageLike, hash: string): boolean {
  const path = externalThreadAuthReturnPath(hash)
  if (!path) {
    if (hash.startsWith('#/sso/done')) return false
    try { storage.removeItem(KEY) } catch { /* storage may be read-only */ }
    return false
  }
  try { storage.setItem(KEY, path); return true } catch { return false }
}

/** Consume once, and reject anything that is not the exact guest Thread route. */
export function takeExternalThreadAuthReturn(storage: StorageLike): string | null {
  let value: string | null = null
  try { value = storage.getItem(KEY) } catch { return null }
  try { storage.removeItem(KEY) } catch { /* storage may be read-only */ }
  return value ? externalThreadAuthReturnPath(value) : null
}
