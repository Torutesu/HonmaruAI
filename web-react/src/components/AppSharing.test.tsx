import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { AppSharing } from './AppSharing'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
let tree: ReactTestRenderer | undefined
afterEach(() => { act(() => tree?.unmount()); vi.unstubAllGlobals() })
const props = { httpBase: 'https://test.local', orgId: 'org', sessionToken: 'session', appId: 'app', appVersion: 4 }

test('sharing sends the displayed version and preserves selection on a conflict', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ access: { visibility: 'private', version: 3 }, canEdit: true, canManage: true, canPublicShare: false, rooms: [] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ shares: [] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Sharing changed. Reload before saving.' }), { status: 409 }))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => { tree = create(<AppSharing {...props} />) })
  expect(tree!.root.findAllByType('select')[0].props.value).toBe('private')
  await act(async () => { tree!.root.findAllByType('select')[0].props.onChange({ target: { value: 'workspace' } }) })
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ orgId: 'org', visibility: 'workspace', version: 3 })
  expect(tree!.root.findAllByType('select')[0].props.value).toBe('private')
  expect(tree!.root.findByProps({ role: 'alert' }).children).toContain('Sharing changed. Reload before saving.')
})

test('readers cannot change audience and do not request link inventory', async () => {
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({ access: { visibility: 'workspace', version: 0 }, canEdit: false, canManage: false, canPublicShare: true, rooms: [] })))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => { tree = create(<AppSharing {...props} />) })
  expect(tree!.root.findByType('select').props.disabled).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

test('public link creation binds the exact app and access versions and lists revocable tokens', async () => {
  const token='app_'+'a'.repeat(64)
  const fetcher=vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ access:{visibility:'workspace',version:8},canManage:true,canPublicShare:true,rooms:[] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ shares:[] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ share:{id:'share-1'},token }),{status:201}))
    .mockResolvedValueOnce(new Response(JSON.stringify({ shares:[{id:'share-1',createdAt:'2026-11-06T00:00:00.000Z',expiresAt:'2026-11-13T00:00:00.000Z',revokedAt:null}] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ revoked:true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ shares:[{id:'share-1',createdAt:'2026-11-06T00:00:00.000Z',expiresAt:'2026-11-13T00:00:00.000Z',revokedAt:'2026-11-06T00:01:00.000Z'}] })))
  vi.stubGlobal('fetch',fetcher)
  await act(async()=>{tree=create(<AppSharing {...props}/>)})
  const consent=tree!.root.findAllByType('input').find(input=>input.props.type==='checkbox')!
  await act(async()=>{consent.props.onChange({target:{checked:true}})})
  const createButton=()=>tree!.root.findAllByType('button').find(button=>button.children.includes('Create link'))!
  await act(async()=>{await createButton().props.onClick()})
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({orgId:'org',version:4,accessVersion:8,confirmDataExposure:true,expiresInDays:7})
  expect(tree!.root.findAllByType('a').some(link=>String(link.props.href).includes(token))).toBe(true)
  const revoke=tree!.root.findAllByType('button').find(button=>button.children.includes('Revoke link'))!
  await act(async()=>{await revoke.props.onClick()})
  expect(fetcher.mock.calls[4][0]).toContain('/public-shares/share-1/revoke?')
})
