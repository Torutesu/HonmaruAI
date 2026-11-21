import { describe, expect, test } from 'vitest'
import { Api, ApiError } from '../src/api'
import { pushTarget, safeAppActivityURL } from '../src/push'

// A pretend Worker for /devices, answering the way worker/src/index.js does.
function server() {
  const calls: Array<{ method: string; path: string; body: unknown; token: string | undefined }> = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers || {}) as Record<string, string>
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init?.method || 'GET', path: url.pathname, body, token: headers['x-session-token'] })
    if (headers['x-session-token'] !== 'tok') return new Response(JSON.stringify({ message: 'invalid session' }), { status: 401 })
    if (url.pathname === '/devices' && init?.method === 'POST' && body?.platform === 'windows') {
      return new Response(JSON.stringify({ message: 'platform is ios or android.' }), { status: 400 })
    }
    return new Response(JSON.stringify({ ok: true }))
  }) as typeof fetch
  return { calls, fetchFn }
}

describe('Api: devices', () => {
  test('registers the native token with its platform, as the signed-in person', async () => {
    const s = server()
    const api = new Api({ base: 'https://api.test/', token: () => 'tok', fetch: s.fetchFn })
    await api.registerDevice({ deviceToken: 'fcm:abc', platform: 'android' })
    await api.registerDevice({ deviceToken: 'a'.repeat(64), platform: 'ios', environment: 'sandbox' })
    expect(s.calls).toEqual([
      { method: 'POST', path: '/devices', body: { deviceToken: 'fcm:abc', platform: 'android' }, token: 'tok' },
      { method: 'POST', path: '/devices', body: { deviceToken: 'a'.repeat(64), platform: 'ios', environment: 'sandbox' }, token: 'tok' },
    ])
  })

  test('unregisters with a DELETE naming the token', async () => {
    const s = server()
    const api = new Api({ base: 'https://api.test', token: () => 'tok', fetch: s.fetchFn })
    expect(await api.unregisterDevice('fcm:abc')).toEqual({ ok: true })
    expect(s.calls).toEqual([{ method: 'DELETE', path: '/devices', body: { deviceToken: 'fcm:abc' }, token: 'tok' }])
  })

  test('says what the server said when it refuses', async () => {
    const s = server()
    const api = new Api({ base: 'https://api.test', token: () => 'tok', fetch: s.fetchFn })
    const err = await api.registerDevice({ deviceToken: 'x', platform: 'windows' as 'ios' }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(400)
    expect(err.message).toBe('platform is ios or android.')
  })
})

describe('pushTarget', () => {
  const target = { kind: 'message', orgId: 'team:a', channel: 'b:cafe', messageId: 'm1' }

  test('reads an iPhone notification: the keys beside aps', () => {
    expect(pushTarget({ aps: { alert: { title: 'Toru' }, 'thread-id': 'team:a|b:cafe' }, kind: 'message', orgId: 'team:a', channel: 'b:cafe', messageId: 'm1', parentId: null }))
      .toEqual(target)
  })

  test('reads an Android notification, parsed or raw', () => {
    // What expo-notifications gives as the data: the JSON under `body`.
    expect(pushTarget({ kind: 'message', orgId: 'team:a', channel: 'b:cafe', messageId: 'm1', parentId: null })).toEqual(target)
    // The raw FCM data: strings, and the same keys again as JSON under `body`.
    expect(pushTarget({ title: 'Toru', message: 'hi', tag: 'team:a|b:cafe', channelId: 'messages', body: JSON.stringify({ kind: 'message', orgId: 'team:a', channel: 'b:cafe', messageId: 'm1' }) }))
      .toEqual(target)
  })

  test('reads an App conversation notification and only keeps a complete record scope', () => {
    const payload = { kind: 'app_activity', orgId: 'team:a', appId: 'app-1', messageId: '42', tableId: 'table-1', rowId: 'row-1' }
    expect(pushTarget(payload)).toEqual(payload)
    expect(pushTarget({ ...payload, rowId: undefined })).toEqual({ kind: 'app_activity', orgId: 'team:a', appId: 'app-1', messageId: '42' })
    expect(pushTarget({ ...payload, tableId: undefined })).toEqual({ kind: 'app_activity', orgId: 'team:a', appId: 'app-1', messageId: '42' })
    expect(pushTarget({ ...payload, appId: '' })).toBeNull()
    expect(pushTarget({ ...payload, rowId: '' })).toEqual({ kind: 'app_activity', orgId: 'team:a', appId: 'app-1', messageId: '42' })
    expect(pushTarget({ ...payload, url: 'https://app.honmaruai.com/#/apps/app-1/team%3Aa?chat=1' })).toMatchObject({ url: 'https://app.honmaruai.com/#/apps/app-1/team%3Aa?chat=1' })
  })

  test('the first source that names a conversation wins', () => {
    expect(pushTarget({}, null, { orgId: 'team:a', channel: 'dm:mika|toru' })).toEqual({ kind: 'message', orgId: 'team:a', channel: 'dm:mika|toru', messageId: null })
  })

  test('anything else is not a conversation', () => {
    expect(pushTarget({ kind: 'created', cardId: 'c1', orgId: 'team:a' })).toBeNull()
    expect(pushTarget({ aps: { 'content-available': 1 }, kind: 'read', orgId: 'team:a', channel: 'b:cafe' })).toBeNull()
    expect(pushTarget({ orgId: 'team:a' })).toBeNull()
    expect(pushTarget({ body: 'not json' })).toBeNull()
    expect(pushTarget({ body: JSON.stringify({ body: JSON.stringify(target) }) })).toBeNull()
    expect(pushTarget(undefined, 'string', 42)).toBeNull()
  })
})

describe('safeAppActivityURL', () => {
  test('allows only credential-free HTTPS links to the Honmaru app origin', () => {
    expect(safeAppActivityURL('https://app.honmaruai.com/#/apps/app-1/team%3Aa?chat=1')).toBe('https://app.honmaruai.com/#/apps/app-1/team%3Aa?chat=1')
    expect(safeAppActivityURL('http://app.honmaruai.com/#/apps/app-1')).toBeNull()
    expect(safeAppActivityURL('https://evil.example/#/apps/app-1')).toBeNull()
    expect(safeAppActivityURL('https://app.honmaruai.com.evil.example/')).toBeNull()
    expect(safeAppActivityURL('https://user:pass@app.honmaruai.com/')).toBeNull()
    expect(safeAppActivityURL('javascript:alert(1)')).toBeNull()
  })
})
