// One channel's messages as a client holds them: ordered by seq, pages
// merged, and caught up by asking for what came after the last seq seen —
// after a reconnect, a deploy, or the app coming back to the front (plan
// §9.3). No UI in here: web, mobile and desktop draw it their own way.

import type { Message } from '../../protocol/src/v2'
import type { Api } from './api'

/// A message of yours not yet confirmed by the server (#212): on its way,
/// or failed — kept, with why, to send again or throw away.
export interface Sending { state: 'pending' | 'failed'; error?: string }
/// A message as drawn. `key` stays the same from the moment it is sent to
/// after the server's copy takes its place, so the row carries on (and can
/// fade up) instead of being drawn anew.
export type HeldMessage = Message & { sending?: Sending; key?: string }

export interface ChannelState {
  messages: HeldMessage[]
  /// The newest seq the server has told us about.
  lastSeq: number
  /// Older pages exist before the first message held.
  hasOlder: boolean
  loading: boolean
  error: string | null
}

type Listener = (state: ChannelState) => void

const PAGE = 50

export class ChannelSync {
  private bySeq = new Map<number, Message>()
  private pending = new Map<string, HeldMessage>() // client id -> optimistic message
  private sends = new Map<string, { body: string; parentId: string | null; alsoChannel: boolean }>()
  private keys = new Map<string, string>() // server id -> the client id it was sent under
  private listeners = new Set<Listener>()
  private state: ChannelState = { messages: [], lastSeq: 0, hasOlder: true, loading: false, error: null }
  private inflight: Promise<void> | null = null

  constructor(private readonly api: Api, readonly orgId: string, readonly channel: string) {}

  get snapshot(): ChannelState { return this.state }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.state)
    return () => { this.listeners.delete(fn) }
  }

  private emit(patch: Partial<ChannelState> = {}) {
    const held: HeldMessage[] = [...this.bySeq.values()].sort((a, b) => a.seq - b.seq)
      .map((m) => (this.keys.has(m.id) ? { ...m, key: this.keys.get(m.id) } : m))
    // Confirmed messages by seq, then ours still on their way in the order
    // they were sent: one confirmed never lands below one still going.
    this.state = { ...this.state, ...patch, messages: [...held, ...this.pending.values()] }
    for (const fn of this.listeners) fn(this.state)
  }

  /// Merge messages from the server; a later copy of the same seq wins.
  apply(messages: Message[], lastSeq?: number) {
    for (const m of messages) {
      if (m.channel !== this.channel) continue
      this.bySeq.set(m.seq, m)
    }
    const newest = Math.max(this.state.lastSeq, lastSeq || 0, ...messages.map((m) => m.seq))
    this.emit({ lastSeq: newest })
  }

  private run(task: () => Promise<void>): Promise<void> {
    if (this.inflight) return this.inflight
    this.emit({ loading: true, error: null })
    this.inflight = task()
      .then(() => this.emit({ loading: false }))
      .catch((err: unknown) => this.emit({ loading: false, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { this.inflight = null })
    return this.inflight
  }

  /// The newest page, the first time a channel is opened.
  open(): Promise<void> {
    return this.run(async () => {
      const page = await this.api.history(this.orgId, this.channel, { limit: PAGE })
      this.apply(page.messages, page.lastSeq)
      const first = page.messages[0]?.seq ?? 1
      this.state = { ...this.state, hasOlder: first > 1 }
    })
  }

  /// Everything after the newest seq held, a page at a time.
  catchUp(): Promise<void> {
    return this.run(async () => {
      for (let i = 0; i < 20; i += 1) {
        const newest = Math.max(0, ...this.bySeq.keys())
        const page = await this.api.history(this.orgId, this.channel, { after: newest, limit: 200 })
        this.apply(page.messages, page.lastSeq)
        if (page.messages.length < 200) return
      }
    })
  }

  /// The page before the oldest message held.
  loadOlder(): Promise<void> {
    if (!this.state.hasOlder) return Promise.resolve()
    return this.run(async () => {
      const oldest = Math.min(...this.bySeq.keys())
      if (!Number.isFinite(oldest) || oldest <= 1) { this.state = { ...this.state, hasOlder: false }; return }
      const page = await this.api.history(this.orgId, this.channel, { before: oldest, limit: PAGE })
      this.apply(page.messages, page.lastSeq)
      const first = page.messages[0]?.seq ?? 1
      this.state = { ...this.state, hasOlder: first > 1 }
    })
  }

  /// A message sent: shown at once, faded, under an id of its own; the
  /// server's copy takes its place only when the server says it has it —
  /// never on the strength of having been drawn. With `parentId`, a reply
  /// in that thread; `alsoChannel` sends it to the conversation too.
  ///
  /// Not sent: refused outright (the words, the sign-in), it is taken back
  /// and the promise rejects. Not reached (the network, the server, too
  /// busy), it stays, failed, to `retry` — under the same id, so a send that
  /// in fact landed is not posted twice — or `discard`; the promise rejects
  /// with `held: true`.
  async send(body: string, author: string, { parentId = null, alsoChannel = false }: { parentId?: string | null; alsoChannel?: boolean } = {}): Promise<Message> {
    const clientId = `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
    const optimistic: HeldMessage = {
      id: clientId, channel: this.channel, seq: Number.MAX_SAFE_INTEGER, author, kind: 'message', body,
      parentId, ...(parentId && alsoChannel ? { alsoChannel: true } : {}), createdAt: new Date().toISOString(), editedAt: null, deletedAt: null,
      key: clientId, sending: { state: 'pending' },
    }
    this.pending.set(clientId, optimistic)
    this.sends.set(clientId, { body, parentId, alsoChannel })
    this.emit()
    return this.deliver(clientId)
  }

  /// A failed one, sent again under the same id.
  retry(clientId: string): Promise<Message> {
    const held = this.pending.get(clientId)
    if (!held || held.sending?.state !== 'failed') return Promise.reject(new Error('Nothing to send again.'))
    this.pending.set(clientId, { ...held, sending: { state: 'pending' } })
    this.emit({ error: null })
    return this.deliver(clientId)
  }

  /// A failed one, thrown away.
  discard(clientId: string) {
    if (this.pending.get(clientId)?.sending?.state !== 'failed') return
    this.pending.delete(clientId)
    this.sends.delete(clientId)
    this.emit()
  }

  private async deliver(clientId: string): Promise<Message> {
    const what = this.sends.get(clientId)!
    try {
      const { message } = await this.api.post(this.orgId, this.channel, what.body, what.parentId || undefined, what.alsoChannel, clientId)
      this.pending.delete(clientId)
      this.sends.delete(clientId)
      this.keys.set(message.id, clientId)
      this.apply([message])
      return message
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      const status = (err as { status?: number })?.status
      const refused = typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
      if (refused) {
        this.pending.delete(clientId)
        this.sends.delete(clientId)
        this.emit({ error: why })
        throw err
      }
      const held = this.pending.get(clientId)
      if (held) this.pending.set(clientId, { ...held, sending: { state: 'failed', error: why } })
      this.emit({ error: why })
      throw Object.assign(err instanceof Error ? err : new Error(why), { held: true, clientId })
    }
  }

  /// Read up to the newest message held.
  markRead(): Promise<unknown> {
    const newest = Math.max(0, ...this.bySeq.keys())
    return newest ? this.api.markRead(this.orgId, this.channel, newest) : Promise.resolve()
  }
}
