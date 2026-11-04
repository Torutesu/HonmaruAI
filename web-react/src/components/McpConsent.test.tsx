import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { McpConsent } from './McpConsent'
import { changeLocale, localeReady } from '../utils/i18n'
const preview = { clientName: 'Claw', clientId: 'client', redirectOrigin: 'https://client.example', scopes: [{ name: 'chat:read', title: 'Read public conversations', description: 'Read public history' }, { name: 'chat:private', title: 'Private channels', description: 'Read private history' }], workspaces: [{ id: 'one', name: 'Team', founder: null }] }
afterEach(() => vi.unstubAllGlobals())
test('consent defaults to public read and posts only selected permissions after an explicit click', async () => {
  const assign = vi.fn(), removeItem = vi.fn()
  vi.stubGlobal('window', { location: { assign } }); vi.stubGlobal('sessionStorage', { removeItem })
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(preview))).mockResolvedValueOnce(new Response(JSON.stringify({ redirectUrl: 'https://client.example/callback?code=one' })))
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<McpConsent httpBase="https://api.example" sessionToken="session" requestId="request" onExit={() => {}} />) })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(tree.root.findAllByType('input').map(input => input.props.checked)).toEqual([true, false])
  await act(async () => { tree.root.findAllByType('button')[0].props.onClick() })
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ approve: true, orgId: 'one', scopes: ['chat:read'] })
  expect(assign).toHaveBeenCalledWith('https://client.example/callback?code=one')
  act(() => tree.unmount())
})
test('a late consent response cannot redirect after the account screen unmounts', async () => {
  const assign = vi.fn()
  vi.stubGlobal('window', { location: { assign } }); vi.stubGlobal('sessionStorage', { removeItem: vi.fn() })
  let finish!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(preview))).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve })))
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<McpConsent httpBase="https://api.example" sessionToken="session" requestId="request" onExit={() => {}} />) })
  await act(async () => { tree.root.findAllByType('button')[0].props.onClick() })
  act(() => tree.unmount())
  await act(async () => { finish(new Response(JSON.stringify({ redirectUrl: 'https://client.example/callback?code=late' }))) })
  expect(assign).not.toHaveBeenCalled()
})
test('the consent page and its permissions read in the person\'s language', async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(preview))))
  let tree!: ReturnType<typeof create>
  try {
    await act(async () => { changeLocale('ja'); await localeReady(); tree = create(<McpConsent httpBase="https://api.example" sessionToken="session" requestId="request" onExit={() => {}} />) })
    const text = JSON.stringify(tree.toJSON())
    expect(text).toContain('Claw を Honmaru に接続')
    expect(text).toContain('公開チャンネルを読む')
    expect(text).toContain('選んだ権限を許可')
    act(() => tree.unmount())
  } finally { act(() => changeLocale('en')) }
})
