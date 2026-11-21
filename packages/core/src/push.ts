// What a tapped notification points at. The Worker sends the same keys to
// both platforms, but they arrive in different shapes: on an iPhone they sit
// beside `aps`; on Android FCM delivers every value as a string, and
// expo-notifications hands the app the JSON under `body` as the data. This
// takes whichever it is given and answers the one question a view has:
// which workspace, which conversation.

export interface PushTarget {
  kind: 'message'
  orgId: string
  channel: string
  messageId: string | null
}

export interface AppActivityPushTarget {
  kind: 'app_activity'
  orgId: string
  appId: string
  messageId: string
  tableId?: string
  rowId?: string
  url?: string
}

export type AnyPushTarget = PushTarget | AppActivityPushTarget

/// Only links back to the production web app may be opened from a push.
/// Notification data is remote input, so schemes and credentials are rejected.
export function safeAppActivityURL(value: unknown): string | null {
  if (!isKey(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'app.honmaruai.com' || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

const isKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200

/// The conversation a notification is about, or null for anything else (a
/// card, a silent read-clearing push, or something malformed). Several
/// sources may be passed — the parsed data first, the raw remote message's
/// data after — and the first that names a conversation wins.
export function pushTarget(...sources: unknown[]): AnyPushTarget | null {
  for (const source of sources) {
    const found = fromOne(source, 0)
    if (found) return found
  }
  return null
}

function fromOne(source: unknown, depth: number): AnyPushTarget | null {
  if (!source || typeof source !== 'object' || depth > 1) return null
  const data = source as Record<string, unknown>
  if (data.kind === 'app_activity') {
    if (!isKey(data.orgId) || !isKey(data.appId) || !isKey(data.messageId)) return null
    const tableId = isKey(data.tableId) ? data.tableId : undefined
    const rowId = isKey(data.rowId) ? data.rowId : undefined
    const url = isKey(data.url) ? data.url : undefined
    return { kind: 'app_activity', orgId: data.orgId, appId: data.appId, messageId: data.messageId, ...(tableId && rowId ? { tableId, rowId } : {}), ...(url ? { url } : {}) }
  }
  if (data.kind !== undefined && data.kind !== 'message') return null
  if (isKey(data.orgId) && isKey(data.channel)) {
    return { kind: 'message', orgId: data.orgId, channel: data.channel, messageId: isKey(data.messageId) ? data.messageId : null }
  }
  // FCM's raw data: the same keys again, as one JSON string.
  if (typeof data.body === 'string') {
    try { return fromOne(JSON.parse(data.body), depth + 1) } catch { return null }
  }
  return null
}
