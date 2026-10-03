import { describe, expect, test } from 'vitest'
import { Api, ApiError } from '../src/api'
import { ChannelSync } from '../src/channelSync'
import type { Message } from '../../protocol/src/v2'

// A pretend Worker: one channel's messages, answering /v2 the way
// worker/src/workspace/v2.js does.
function server(start = 0) {
  const messages: Message[] = []
  const add = (body: string) => {
    const seq = messages.length + 1
    const m: Message = { id: `m${seq}`, channel: 'b:cafe', seq, author: 'aya', kind: 'message', body, parentId: null, createdAt: new Date(seq * 1000).toISOString(), editedAt: null, deletedAt: null }
    messages.push(m)
    return m
  }
  for (let i = 0; i < start; i += 1) add(`m${i + 1}`)
  const calls: string[] = []
  const reads: number[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(`${init?.method || 'GET'} ${url.pathname}${url.search}`)
    if (init?.headers && (init.headers as Record<string, string>)['x-session-token'] !== 'tok') {
      return new Response(JSON.stringify({ message: 'Please sign in.' }), { status: 401 })
    }
    if (url.pathname.endsWith('/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      const m = add(body.body)
      if (body.parentId) { m.parentId = body.parentId; if (body.alsoChannel) m.alsoChannel = true }
      return new Response(JSON.stringify({ message: m }), { status: 201 })
    }
    if (url.pathname.endsWith('/messages')) {
      const after = url.searchParams.get('after'); const before = url.searchParams.get('before')
      const limit = Number(url.searchParams.get('limit') || 50)
      let page: Message[]
      if (after !== null) page = messages.filter((m) => m.seq > Number(after)).slice(0, limit)
      else if (before !== null) page = messages.filter((m) => m.seq < Number(before)).slice(-limit)
      else page = messages.slice(-limit)
      return new Response(JSON.stringify({ messages: page, lastSeq: messages.length }))
    }
    if (url.pathname.endsWith('/read')) {
      reads.push(JSON.parse(String(init?.body)).seq)
      return new Response(JSON.stringify({ ok: true }))
    }
    return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 })
  }) as typeof fetch
  return { add, calls, reads, fetchFn, messages }
}

describe('ChannelSync', () => {
  test('opens on the newest page, loads older pages, and knows when there are no more', async () => {
    const s = server(120)
    const sync = new ChannelSync(new Api({ base: 'https://api.test', token: () => 'tok', fetch: s.fetchFn }), 'team:a', 'b:cafe')
    await sync.open()
    expect(sync.snapshot.messages.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 71 + i))
    expect(sync.snapshot.hasOlder).toBe(true)
    await sync.loadOlder(); await sync.loadOlder()
    expect(sync.snapshot.messages).toHaveLength(120)
    expect(sync.snapshot.messages[0].seq).toBe(1)
    expect(sync.snapshot.hasOlder).toBe(false)
  })

  test('catching up asks only for what came after the newest seq held', async () => {
    const s = server(3)
    const sync = new ChannelSync(new Api({ base: 'https://api.test', token: () => 'tok', fetch: s.fetchFn }), 'team:a', 'b:cafe')
    await sync.open()
    for (let i = 0; i < 250; i += 1) s.add(`late ${i}`)
    s.calls.length = 0
    await sync.catchUp()
    expect(s.calls).toEqual([
      'GET /v2/w/team%3Aa/channels/b%3Acafe/messages?after=3&limit=200',
      'GET /v2/w/team%3Aa/channels/b%3Acafe/messages?after=203&limit=200',
    ])
    expect(sync.snapshot.messages).toHaveLength(253)
    expect(sync.snapshot.lastSeq).toBe(253)
  })

  test('a message sent shows at once and is replaced by the server copy', async () => {
    const s = server(1)
    const sync = new ChannelSync(new Api({ base: 'https://api.test', token: () => 'tok', fetch: s.fetchFn }), 'team:a', 'b:cafe')
    await sync.open()
    const seen: string[][] = []
    sync.subscribe((st) => seen.push(st.messages.map((m) => (m.id.startsWith('pending:') ? 'pending' : m.id))))
    await sync.send('hello', 'aya')
    expect(seen).toContainEqual(['m1', 'pending'])
    expect(sync.snapshot.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    await sync.markRead()
    expect(s.reads).toEqual([2])
  })

  test('a send the server refuses is taken back and says why', async () => {
    const s = server(0)
    const sync = new ChannelSync(new Api({ base: 'https://api.test', token: () => 'wrong', fetch: s.fetchFn }), 'team:a', 'b:cafe')
    await expect(sync.send('hi', 'aya')).rejects.toBeInstanceOf(ApiError)
    expect(sync.snapshot.messages).toEqual([])
    expect(sync.snapshot.error).toBe('Please sign in.')
  })
})

describe('Api', () => {
  test('errors carry the status, the message and retry-after', async () => {
    const api = new Api({
      base: 'https://api.test/',
      fetch: (async () => new Response(JSON.stringify({ message: 'Slow down.' }), { status: 429, headers: { 'retry-after': '30' } })) as typeof fetch,
    })
    const err = await api.me().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 429, message: 'Slow down.', retryAfter: 30 })
  })

  test('a thread reply is sent under its parent, to the conversation too when asked, and threads are read from the channel', async () => {
    const { inConversation, replyStats, threadOf } = await import('../src/threads')
    const s = server(1)
    const sync = new ChannelSync(new Api({ base: 'https://api.test', token: () => 'tok', fetch: s.fetchFn }), 'team:a', 'b:cafe')
    await sync.open()
    const parent = sync.snapshot.messages[0]
    await sync.send('in the thread', 'aya', { parentId: parent.id })
    await sync.send('in both', 'aya', { parentId: parent.id, alsoChannel: true })
    await sync.send('top level', 'aya')
    const all = sync.snapshot.messages
    expect(inConversation(all).map((m) => m.body)).toEqual(['m1', 'in both', 'top level'])
    expect(replyStats(all).get(parent.id)?.count).toBe(2)
    expect(threadOf(all, parent.id)?.replies.map((m) => m.body)).toEqual(['in the thread', 'in both'])
    expect(threadOf(all, 'nope')).toBeNull()
  })
})
