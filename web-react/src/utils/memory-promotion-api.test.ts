import { afterEach, expect, test, vi } from 'vitest'
import { harnessApi } from './harness'

afterEach(() => vi.unstubAllGlobals())

test('personal memory promotion API uses the source version and expected approval endpoints', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ request: { id: 'req' } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ requests: [] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ request: { id: 'req', status: 'approved' } }) })
  vi.stubGlobal('fetch', fetch)
  const api = harnessApi('https://example.test', 'org', 'session')
  const memory = { id: 'memory/id', text: 'Private content', source: 'person', createdAt: '2026-11-01', version: 4 }
  await api.promoteMemory('agent/id', memory, 'mem-promo-123')
  expect(fetch.mock.calls[0][0]).toBe('https://example.test/hx/agents/agent%2Fid/memory/promotions')
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ orgId: 'org', memoryId: 'memory/id', expectedVersion: 4, requestKey: 'mem-promo-123' })
  await api.memoryPromotions('agent/id')
  expect(new URL(fetch.mock.calls[1][0]).pathname).toBe('/hx/agents/agent%2Fid/memory/promotions')
  expect(new URL(fetch.mock.calls[1][0]).searchParams.get('orgId')).toBe('org')
  await api.decideMemoryPromotion('agent/id', 'request/id', 'approve')
  expect(fetch.mock.calls[2][0]).toBe('https://example.test/hx/agents/agent%2Fid/memory/promotions/request%2Fid')
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ orgId: 'org', decision: 'approve' })
  expect(fetch.mock.calls[2][1].headers['x-session-token']).toBe('session')
})
