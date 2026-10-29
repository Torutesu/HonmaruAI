import type { ChannelMessage } from '../types/card'
import { isTemp, arrive } from './pendingSend'
import { newerPin } from './messagePin'
import { refreshQuotes } from './replies'

export type ThreadSnapshot = { parent: ChannelMessage; replies: ChannelMessage[]; more?: boolean; nextCursor?: string | null }
type ReadPage = (before?: string) => Promise<{ status: number; data: ThreadSnapshot | null }>
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
    const previous = this.entries.get(key)?.snapshot
    this.entries.delete(key)
    this.entries.set(key, { snapshot: { ...previous, parent, replies: replies.filter(row => !isTemp(row)) }, at })
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
  load(channel: string, parentId: string, fetchThread: ReadPage, force = false): Promise<ThreadResult> {
    return this.read(channel, parentId, fetchThread, force, false)
  }
  loadOlder(channel: string, parentId: string, fetchThread: ReadPage): Promise<ThreadResult> {
    return this.read(channel, parentId, fetchThread, true, true)
  }
  private read(channel: string, parentId: string, fetchThread: ReadPage, force: boolean, older: boolean): Promise<ThreadResult> {
    const key = keyOf(channel, parentId)
    const active = this.pending.get(key)
    if (active) return active.promise
    const kept = this.get(channel, parentId)
    if (older && !kept?.nextCursor) return Promise.resolve(kept || null)
    if (!force && this.fresh(channel, parentId)) return Promise.resolve(kept!)
    const lifetime = this.lifetime
    const failed = () => { const entry = this.entries.get(key); if (entry) entry.at = -Infinity; return null }
    const request = { promise: null as unknown as Promise<ThreadResult>, changes: new Map<string, ChannelMessage>() }
    request.promise = Promise.resolve().then(async (): Promise<ThreadResult> => {
      while (lifetime === this.lifetime) {
        const generation = this.generation
        request.changes.clear()
        // Reconnect reads through the oldest displayed row, filling any offline
        // gap and removing deleted rows only inside the range actually reread.
        const baseline = this.get(channel, parentId)
        const oldest = !older && baseline?.more !== undefined ? baseline.replies[0] : undefined
        let cursor = older ? baseline?.nextCursor || undefined : undefined
        let snapshot: ThreadSnapshot | undefined
        const visited = new Set<string>()
        do {
          let response
          try { response = await fetchThread(cursor) } catch { return lifetime === this.lifetime ? failed() : 'obsolete' }
          if (lifetime !== this.lifetime) return 'obsolete'
          if (generation !== this.generation) break
          if ([401, 403, 404, 410].includes(response.status) || response.data?.parent?.deleted) { this.entries.delete(key); return 'denied' }
          const data = response.data
          if (response.status < 200 || response.status >= 300 || !data?.parent || data.parent.id !== parentId || data.parent.channel !== channel) return failed()
          if (data.replies != null && !Array.isArray(data.replies)) return failed()
          if (data.more && (typeof data.nextCursor !== 'string' || !data.nextCursor || visited.has(data.nextCursor))) return failed()
          const replies = data.replies || []
          snapshot = { ...data, replies: [...replies, ...(snapshot?.replies || [])] }
          if (older || !oldest || !data.more || replies.some(row => row.id === oldest.id) || (replies.length && replies[0].createdAt < oldest.createdAt)) break
          cursor = data.nextCursor!
          visited.add(cursor)
        } while (cursor)
        if (generation !== this.generation) { older = false; continue }
        if (!snapshot) return failed()
        if (older && baseline) {
          const known = new Set(baseline.replies.map(row => row.id))
          snapshot.replies = [...snapshot.replies.filter(row => !known.has(row.id)), ...baseline.replies]
        }
        // Stable IDs merge live edits, arrivals and tombstones received during
        // any of the page reads, including before the first snapshot exists.
        for (const message of request.changes.values()) {
          snapshot = changed(snapshot, message)
          if (!snapshot) { this.entries.delete(key); return 'denied' }
        }
        this.remember(channel, snapshot.parent, snapshot.replies, !older)
        this.entries.get(key)!.snapshot = snapshot
        return snapshot
      }
      return 'obsolete'
    }).finally(() => { if (this.pending.get(key) === request) this.pending.delete(key) })
    this.pending.set(key, request)
    return request.promise
  }
}
