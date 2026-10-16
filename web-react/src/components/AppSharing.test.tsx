import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { AppSharing } from './AppSharing'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
let tree: ReactTestRenderer | undefined
afterEach(() => { act(() => tree?.unmount()); vi.unstubAllGlobals() })
const props = { httpBase: 'https://test.local', orgId: 'org', sessionToken: 'session', appId: 'app' }

test('sharing sends the displayed version and preserves private selection on a conflict', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access: { visibility: 'private', version: 3 }, canEdit: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Sharing changed. Reload before saving.' }), { status: 409 }))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => { tree = create(<AppSharing {...props} />) })
  expect(tree!.root.findByType('select').props.value).toBe('private')
  await act(async () => { tree!.root.findByType('select').props.onChange({ target: { value: 'workspace' } }) })
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ orgId: 'org', visibility: 'workspace', version: 3 })
  expect(tree!.root.findByType('select').props.value).toBe('private')
  expect(tree!.root.findByProps({ role: 'alert' }).children).toContain('Sharing changed. Reload before saving.')
})

test('readers can see the policy but cannot change it', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ access: { visibility: 'workspace', version: 0 }, canEdit: false }))))
  await act(async () => { tree = create(<AppSharing {...props} />) })
  expect(tree!.root.findByType('select').props.disabled).toBe(true)
})
