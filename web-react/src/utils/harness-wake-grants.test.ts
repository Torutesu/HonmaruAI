import { afterEach, expect, test, vi } from 'vitest'
import { harnessApi } from './harness'

afterEach(() => vi.unstubAllGlobals())

test('Agent wake grant revoke sends its ID as a query on the human-session DELETE route', async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init })
    return { ok: true, json: async () => ({ revoked: true }) }
  }))

  await harnessApi('https://api.example.test', 'org_1', 'human-session').revokeAgentWakeGrant('wake_1')

  expect(calls).toHaveLength(1)
  expect(calls[0].url.pathname).toBe('/hx/agent-wake-grants')
  expect(calls[0].url.searchParams.get('orgId')).toBe('org_1')
  expect(calls[0].url.searchParams.get('grantId')).toBe('wake_1')
  expect(calls[0].init?.method).toBe('DELETE')
  expect(calls[0].init?.body).toBeUndefined()
  expect((calls[0].init?.headers as Record<string, string>)['x-session-token']).toBe('human-session')
})
