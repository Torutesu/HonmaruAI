import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { AppSharing } from './AppSharing'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
let tree: ReactTestRenderer | undefined
afterEach(() => { act(() => tree?.unmount()); vi.unstubAllGlobals() })
const props = { httpBase: 'https://test.local', orgId: 'org', sessionToken: 'session', appId: 'app' }
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const settings = { share: null, appVersion: 4, entities: [{ key: 'primary', name: 'Tasks', fields: [{ id: 'title', name: 'Title' }, { id: 'secret', name: 'Secret' }] }, { key: 'customers', name: 'Customers', fields: [{ id: 'company', name: 'Company' }] }] }

test('sharing sends the displayed version and preserves private selection on a conflict', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ access: { visibility: 'private', version: 3 }, canEdit: true })).mockResolvedValueOnce(response(settings))
    .mockResolvedValueOnce(response({ message: 'Sharing changed. Reload before saving.' }, 409))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => { tree = create(<AppSharing {...props} />) })
  expect(tree!.root.findByType('select').props.value).toBe('private')
  await act(async () => { tree!.root.findByType('select').props.onChange({ target: { value: 'workspace' } }) })
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ orgId: 'org', visibility: 'workspace', version: 3 })
  expect(tree!.root.findByType('select').props.value).toBe('private')
  expect(tree!.root.findByProps({ role: 'alert' }).children).toContain('Sharing changed. Reload before saving.')
})

test('readers can see the policy but cannot change it', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ access: { visibility: 'workspace', version: 0 }, canEdit: false })).mockResolvedValueOnce(response({ share: null, appVersion: 1, entities: [] })))
  await act(async () => { tree = create(<AppSharing {...props} />) })
  expect(tree!.root.findByType('select').props.disabled).toBe(true)
})

test('public link creation requires selected fields and explicit confirmation', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ access: { visibility: 'private', version: 2 }, canEdit: true }))
    .mockResolvedValueOnce(response(settings))
    .mockResolvedValueOnce(response({ share: { id: 'share-1', appVersion: 4, dataScope: [{ entity: 'primary', fields: ['title'] }], url: '/app-shares/token', createdAt: 'now' } }, 201))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => { tree = create(<AppSharing {...props} />) })
  let boxes = tree!.root.findAllByType('input').filter(input => input.props.type === 'checkbox')
  expect(tree!.root.findAllByType('button').find(button => button.children.includes('Create public link'))!.props.disabled).toBe(true)
  await act(async () => { boxes[0].props.onChange({ target: { checked: true } }) })
  expect(tree!.root.findAllByType('button').find(button => button.children.includes('Create public link'))!.props.disabled).toBe(true)
  boxes = tree!.root.findAllByType('input').filter(input => input.props.type === 'checkbox')
  await act(async () => { boxes[2].props.onChange({ target: { checked: true } }) })
  boxes = tree!.root.findAllByType('input').filter(input => input.props.type === 'checkbox')
  await act(async () => { boxes[3].props.onChange({ target: { checked: true } }) })
  await act(async () => { tree!.root.findAllByType('button').find(button => button.children.includes('Create public link'))!.props.onClick() })
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ orgId: 'org', appVersion: 4, accessVersion: 2, entities: [{ entity: 'primary', fields: ['title'] }, { entity: 'customers', fields: ['company'] }], publicDataConfirmed: true })
  expect(tree!.root.findByProps({ 'aria-label': 'Public URL' }).props.value).toBe('https://test.local/app-shares/token')
})
