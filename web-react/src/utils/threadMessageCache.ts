import type { ChannelMessage } from '../types/card'
import { isTemp, arrive } from './pendingSend'
import { newerPin } from './messagePin'
import { refreshQuotes } from './replies'

export type ThreadSnapshot = { parent: ChannelMessage; replies: ChannelMessage[] }
export type ThreadResult = ThreadSnapshot | 'denied' | 'obsolete' | null
const FRESH_MS = 60_000
const keyOf = (channel: string, parentId: string) => JSON.stringify([channel, parentId])

function changed(snapshot: ThreadSnapshot, message: ChannelMessage): ThreadSnapshot | undefined {
  if (!message.parentId) return message.deleted ? undefined : { ...snapshot, parent: { ...newerPin(snapshot.parent, message), canRenameThread: snapshot.parent.canRenameThread } }
  return { ...snapshot, replies: refreshQuotes(message.deleted ? snapshot.replies.filter(row => row.id !== message.id) : arrive(snapshot.replies, message), message) }
}

// Owned by the account/workspace message cache. Prefetch, visits and reconnects
// share both the snapshot and the request; only visits mark a thread read.
export class ThreadMessageCache {
  private entries = new Map<string, { snapshot: ThreadSnapshot; at: number }>()
  private pending = new Map<string, { promise: Promise<ThreadResult>; changes: Map<string, ChannelMessage> }>()
  private generation = 0
  private lifetime = 0
  get(channel: string, parentId: string): ThreadSnapshot | undefined { return this.entries.get(keyOf(channel, parentId))?.snapshot }
  fresh(channel: string, parentId: string): boolean {
    const entry = this.entries.get(keyOf(channel, parentId))
    return Boolean(entry && Date.now() - entry.at < FRESH_MS)
  }
  remember(channel: string, parent: ChannelMessage, replies: ChannelMessage[], read = false) {
    const key = keyOf(channel, parent.id)
    const at = read ? Date.now() : (this.entries.get(key)?.at ?? -Infinity)
    this.entries.delete(key)
    this.entries.set(key, { snapshot: { parent, replies: replies.filter(row => !isTemp(row)) }, at })
    while (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value!)
  }
  change(message: ChannelMessage) {
    const key = keyOf(message.channel, message.parentId || message.id)
    // Includes deletions during a first prefetch, before any snapshot exists.
    const changes = this.pending.get(key)?.changes
    if (!changes?.get(message.id)?.deleted) changes?.set(message.id, message)
    const entry = this.entries.get(key)
    if (!entry) return
    const snapshot = changed(entry.snapshot, message)
    if (snapshot) entry.snapshot = snapshot
    else this.entries.delete(key)
  }
  invalidate() {
    this.generation++
    for (const entry of this.entries.values()) entry.at = -Infinity
  }
  clear() {
    this.lifetime++
    this.invalidate()
    this.entries.clear()
    this.pending.clear()
  }
  load(channel: string, parentId: string, fetchThread: () => Promise<{ status: number; data: ThreadSnapshot | null }>, force = false): Promise<ThreadResult> {
    const key = keyOf(channel, parentId)
    const active = this.pending.get(key)
    if (active) return active.promise
    if (!force && this.fresh(channel, parentId)) return Promise.resolve(this.get(channel, parentId)!)
    const lifetime = this.lifetime
    const failed = () => { const entry = this.entries.get(key); if (entry) entry.at = -Infinity; return null }
    const request = { promise: null as unknown as Promise<ThreadResult>, changes: new Map<string, ChannelMessage>() }
    request.promise = Promise.resolve().then(async (): Promise<ThreadResult> => {
      // Invalidation during a read queues a single newer read, never a parallel
      // request that could restore an older snapshot after the refresh.
      while (lifetime === this.lifetime) {
        const generation = this.generation
        request.changes.clear()
        let response
        try { response = await fetchThread() } catch { return lifetime === this.lifetime ? failed() : 'obsolete' }
        if (lifetime !== this.lifetime) return 'obsolete'
        if (generation !== this.generation) continue
        if ([401, 403, 404, 410].includes(response.status)) { this.entries.delete(key); return 'denied' }
        if (response.data?.parent?.deleted) { this.entries.delete(key); return 'denied' }
        if (response.status < 200 || response.status >= 300 || !response.data?.parent || response.data.parent.id !== parentId || response.data.parent.channel !== channel) return failed()
        if (response.data.replies != null && !Array.isArray(response.data.replies)) return failed()
        let snapshot: ThreadSnapshot | undefined = { parent: response.data.parent, replies: response.data.replies || [] }
        for (const message of request.changes.values()) {
          snapshot = changed(snapshot, message)
          if (!snapshot) { this.entries.delete(key); return 'denied' }
        }
        this.remember(channel, snapshot.parent, snapshot.replies, true)
        return this.get(channel, parentId)!
      }
      return 'obsolete'
    }).finally(() => { if (this.pending.get(key) === request) this.pending.delete(key) })
    this.pending.set(key, request)
    return request.promise
  }
}
