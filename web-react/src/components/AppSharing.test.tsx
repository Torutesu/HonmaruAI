import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { AppSharing } from './AppSharing'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
let tree: ReactTestRenderer | undefined
afterEach(() => { act(() => tree?.unmount()); vi.unstubAllGlobals() })
const props = { httpBase: 'https://test.local', orgId: 'org', sessionToken: 'session', appId: 'app' }

test('sharing sends the displayed version and preserves private selection on a conflict', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access: { visibility: 'private', version: 3 }, canEdit: true, people: [
    { userId: '42', login: 'mika', name: 'Mika', permission: 'view', explicit: true, role: 'member' },
    { userId: '43', login: 'yui', name: 'Yui', permission: 'none', explicit: false, role: 'member' },
  ] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Sharing changed. Reload before saving.' }), { status: 409 }))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => { tree = create(<AppSharing {...props} />) })
  const peopleSection = tree!.root.findByProps({ className: 'app-sharing-people' })
  expect(peopleSection.type).toBe('section')
  expect(peopleSection.props['aria-labelledby']).toBe('app-sharing-people-title-app')
  expect(tree!.root.findByProps({ id: 'app-sharing-people-title-app' }).type).toBe('h3')
  expect(tree!.root.findAllByType('select')[0].props.value).toBe('private')
  await act(async () => { tree!.root.findAllByType('select')[0].props.onChange({ target: { value: 'workspace' } }) })
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ orgId: 'org', visibility: 'workspace', version: 3, people: [{ userId: '42', permission: 'view' }] })
  expect(tree!.root.findAllByType('select')[0].props.value).toBe('private')
  expect(tree!.root.findByProps({ role: 'alert' }).children).toContain('Sharing changed. Reload before saving.')
})

test('readers can see the policy but cannot change it', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ access: { visibility: 'workspace', version: 0 }, canEdit: false, people: [
    { userId: '42', login: 'mika', name: 'Mika', permission: 'view', explicit: false, role: 'member' },
  ] }))))
  await act(async () => { tree = create(<AppSharing {...props} />) })
  expect(tree!.root.findAllByType('select')[0].props.disabled).toBe(true)
  expect(tree!.root.findAllByType('select')[1].props.disabled).toBe(true)
})

test('a person override is saved with a version and inherited members are omitted', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access: { visibility: 'workspace', version: 4 }, canEdit: true, people: [
    { userId: '1', login: 'owner', name: 'Owner', permission: 'edit', explicit: false, role: 'owner', canOverride: false },
    { userId: '2', login: 'mika', name: 'Mika', permission: 'view', explicit: false, role: 'member' },
    { userId: '3', login: 'yui', name: 'Yui', permission: 'none', explicit: true, role: 'member' },
  ] }))).mockResolvedValueOnce(new Response(JSON.stringify({ access: { visibility: 'workspace', version: 5 }, canEdit: true, people: [
    { userId: '1', login: 'owner', name: 'Owner', permission: 'edit', explicit: false, role: 'owner', canOverride: false },
    { userId: '2', login: 'mika', name: 'Mika', permission: 'edit', explicit: true, role: 'member' },
    { userId: '3', login: 'yui', name: 'Yui', permission: 'none', explicit: true, role: 'member' },
  ] })))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => { tree = create(<AppSharing {...props} />) })
  const selects = tree!.root.findAllByType('select')
  expect(selects[1].props.value).toBe('inherit')
  expect(selects[1].props.disabled).toBe(true)
  await act(async () => { selects[2].props.onChange({ target: { value: 'edit' } }) })
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ orgId: 'org', visibility: 'workspace', version: 4, people: [
    { userId: '2', permission: 'edit' }, { userId: '3', permission: 'none' },
  ] })
  expect(tree!.root.findAllByType('select')[2].props.value).toBe('edit')
})
