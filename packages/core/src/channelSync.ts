// One channel's messages as a client holds them: ordered by seq, pages
// merged, and caught up by asking for what came after the last seq seen —
// after a reconnect, a deploy, or the app coming back to the front (plan
// §9.3). No UI in here: web, mobile and desktop draw it their own way.

import type { Message } from '../../protocol/src/v2'
import type { Api } from './api'

export interface ChannelState {
  messages: Message[]
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
  private pending = new Map<string, Message>() // client id -> optimistic message
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
    const held = [...this.bySeq.values()].sort((a, b) => a.seq - b.seq)
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

  /// A message sent: shown at once, replaced by the server's copy. With
  /// `parentId`, a reply in that thread; `alsoChannel` sends it to the
  /// conversation too.
  async send(body: string, author: string, { parentId = null, alsoChannel = false }: { parentId?: string | null; alsoChannel?: boolean } = {}): Promise<Message> {
    const clientId = `pending:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const optimistic: Message = {
      id: clientId, channel: this.channel, seq: Number.MAX_SAFE_INTEGER, author, kind: 'message', body,
      parentId, ...(parentId && alsoChannel ? { alsoChannel: true } : {}), createdAt: new Date().toISOString(), editedAt: null, deletedAt: null,
    }
    this.pending.set(clientId, optimistic)
    this.emit()
    try {
      const { message } = await this.api.post(this.orgId, this.channel, body, parentId || undefined, alsoChannel)
      this.pending.delete(clientId)
      this.apply([message])
      return message
    } catch (err) {
      this.pending.delete(clientId)
      this.emit({ error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  /// Read up to the newest message held.
  markRead(): Promise<unknown> {
    const newest = Math.max(0, ...this.bySeq.keys())
    return newest ? this.api.markRead(this.orgId, this.channel, newest) : Promise.resolve()
  }
}
