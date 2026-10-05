import type { ChannelMessage } from '../types/card'
import { isTemp } from './pendingSend'
import { ViewCache } from './viewCache'

// Memory only: message contents and session identities never go to disk.
// A bounded cache survives switching away from the chat screen in this tab.
const MAX_CHANNELS = 30
const MAX_MESSAGES = 300
const FRESH_MS = 60_000
let nextIdentity = 0
export class ChannelMessageCache {
  readonly identity = ++nextIdentity
  /// Profiles, threads and lists, for the same account and workspace.
  readonly views = new ViewCache()
  messages: Record<string, ChannelMessage[]> = {}
  more: Record<string, boolean> = {}
  private fetched = new Map<string, number>()
  private pending = new Map<string, Promise<void>>()
  private generation = 0
  private touched = new Map<string, number>()
  private sequence = 0
  remember(messages: Record<string, ChannelMessage[]>, more: Record<string, boolean>) {
    for (const [channel, rows] of Object.entries(messages)) {
      const saved = rows.filter((m) => !isTemp(m))
      this.messages[channel] = saved.slice(-MAX_MESSAGES)
      this.more[channel] = Boolean(more[channel]) || saved.length > MAX_MESSAGES
    }
    const channels = Object.keys(this.messages).sort((a, b) => (this.touched.get(a) || 0) - (this.touched.get(b) || 0))
    for (const channel of channels.slice(0, Math.max(0, channels.length - MAX_CHANNELS))) {
      delete this.messages[channel]; delete this.more[channel]; this.fetched.delete(channel)
    }
  }
  invalidate() { this.generation++; this.fetched.clear(); this.pending.clear() }
  clear() { this.invalidate(); this.messages = {}; this.more = {}; this.views.clear() }
  forget(channel: string) { delete this.messages[channel]; delete this.more[channel]; this.fetched.delete(channel) }
  load(channel: string, fetchPage: (isCurrent: () => boolean) => Promise<boolean>, force = false): Promise<void> {
    this.touched.set(channel, ++this.sequence)
    const active = this.pending.get(channel)
    if (active) return active
    const at = this.fetched.get(channel)
    if (!force && at !== undefined && Date.now() - at < FRESH_MS) return Promise.resolve()
    const generation = this.generation
    const task = Promise.resolve().then(() => fetchPage(() => generation === this.generation)).then((ok) => {
      if (ok && generation === this.generation) this.fetched.set(channel, Date.now())
    }).finally(() => { if (this.pending.get(channel) === task) this.pending.delete(channel) })
    this.pending.set(channel, task)
    return task
  }
}
const scopes = new Map<string, ChannelMessageCache>()
export function channelMessageCache(api: { httpBase: string; orgId: string; sessionToken: string }): ChannelMessageCache {
  const key = JSON.stringify([api.httpBase, api.orgId, api.sessionToken])
  let cache = scopes.get(key)
  if (!cache) { cache = new ChannelMessageCache(); scopes.set(key, cache) }
  while (scopes.size > 4) { const oldest = scopes.keys().next().value!; scopes.get(oldest)?.clear(); scopes.delete(oldest) }
  return cache
}
export function clearMessageCaches() { for (const cache of scopes.values()) cache.clear(); scopes.clear() }

// A latest-page response replaces its covered range, but cannot undo socket
// events received while the request was in flight (including a deletion).
export function mergeLatestMessages(current: ChannelMessage[], page: ChannelMessage[], before: ChannelMessage[], reset: boolean, complete: boolean): ChannelMessage[] {
  const baseline = new Map(before.map((m) => [m.id, m]))
  const now = new Map(current.map((m) => [m.id, m]))
  const merged = new Map<string, ChannelMessage>()
  if (!reset && !complete && page.length) for (const m of current) {
    if (m.createdAt < page[0].createdAt) merged.set(m.id, m)
  }
  for (const m of page) merged.set(m.id, m)
  for (const m of current) if (isTemp(m) || baseline.get(m.id) !== m) merged.set(m.id, m)
  for (const m of before) if (!now.has(m.id)) merged.delete(m.id)
  return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
