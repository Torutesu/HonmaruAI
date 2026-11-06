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
    .mockResolvedValueOnce(new Response(JSON.stringify({ permissions: [] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ shares: [] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Sharing changed. Reload before saving.' }), { status: 409 }))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => { tree = create(<AppSharing {...props} />) })
  expect(tree!.root.findAllByType('select')[0].props.value).toBe('private')
  await act(async () => { tree!.root.findAllByType('select')[0].props.onChange({ target: { value: 'workspace' } }) })
  expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({ orgId: 'org', visibility: 'workspace', version: 3 })
  expect(tree!.root.findAllByType('select')[0].props.value).toBe('private')
  expect(tree!.root.findByProps({ role: 'alert' }).children).toContain('Sharing changed. Reload before saving.')
})

test('readers cannot change audience and do not request link inventory', async () => {
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({ access: { visibility: 'workspace', version: 0 }, canEdit: false, canManage: false, canPublicShare: true, rooms: [] })))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => { tree = create(<AppSharing {...props} />) })
  expect(tree!.root.findAllByType('select')[0].props.disabled).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

test('public link creation binds the exact app and access versions and lists revocable tokens', async () => {
  const token='app_'+'a'.repeat(64)
  const fetcher=vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ access:{visibility:'workspace',version:8},canManage:true,canPublicShare:true,rooms:[] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ permissions:[] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ shares:[] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ share:{id:'share-1'},token }),{status:201}))
    .mockResolvedValueOnce(new Response(JSON.stringify({ shares:[{id:'share-1',createdAt:'2026-11-06T00:00:00.000Z',expiresAt:'2026-11-13T00:00:00.000Z',revokedAt:null}] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ revoked:true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ shares:[{id:'share-1',createdAt:'2026-11-06T00:00:00.000Z',expiresAt:'2026-11-13T00:00:00.000Z',revokedAt:'2026-11-06T00:01:00.000Z'}] })))
  vi.stubGlobal('location', { origin: 'https://app.test' })
  vi.stubGlobal('fetch',fetcher)
  await act(async()=>{tree=create(<AppSharing {...props}/>)})
  const consent=tree!.root.findAllByType('input').find(input=>input.props.type==='checkbox')!
  await act(async()=>{consent.props.onChange({target:{checked:true}})})
  const createButton=()=>tree!.root.findAllByType('button').find(button=>button.children.includes('Create link'))!
  await act(async()=>{await createButton().props.onClick()})
  expect(JSON.parse(fetcher.mock.calls[3][1].body)).toMatchObject({orgId:'org',version:4,accessVersion:8,confirmDataExposure:true,expiresInDays:7})
  expect(tree!.root.findAllByType('a').some(link=>String(link.props.href).includes(token))).toBe(true)
  const revoke=tree!.root.findAllByType('button').find(button=>button.children.includes('Revoke link'))!
  await act(async()=>{await revoke.props.onClick()})
  expect(fetcher.mock.calls[5][0]).toContain('/public-shares/share-1/revoke?')
})

test('workspace admins may manage public links without changing owner-only audience', async () => {
  const fetcher=vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({access:{visibility:'private',version:5},canEdit:false,canManage:true,canPublicShare:true,rooms:[]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({permissions:[]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({shares:[]})))
  vi.stubGlobal('fetch',fetcher)
  await act(async()=>{tree=create(<AppSharing {...props}/>)})
  expect(tree!.root.findAllByType('select')[0].props.disabled).toBe(true)
  const consent=tree!.root.findAllByType('input').find(input=>input.props.type==='checkbox')!
  expect(consent.props.disabled).toBe(false)
  expect(tree!.root.findAllByType('button').find(button=>button.children.includes('Create link'))!.props.disabled).toBe(true)
})


test('owner and admins can set member permissions and see effective inherited access', async () => {
  const fetcher=vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({access:{visibility:'room',version:2},canEdit:false,canManage:true,canPublicShare:false,rooms:[]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({permissions:[
      {userId:'member-1',name:'Mika',login:'mika',role:'member',permission:null,effectivePermission:'edit',version:null},
      {userId:'member-2',name:'Gina',login:'gina',role:'member',permission:null,effectivePermission:'none',version:null}
    ]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({shares:[]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({permissions:[
      {userId:'member-1',name:'Mika',login:'mika',role:'member',permission:null,effectivePermission:'edit',version:null},
      {userId:'member-2',name:'Gina',login:'gina',role:'member',permission:'view',effectivePermission:'view',version:1}
    ]})))
  vi.stubGlobal('fetch',fetcher)
  await act(async()=>{tree=create(<AppSharing {...props}/>)})
  expect(tree!.root.findAllByType('select').at(-1)!.props['aria-label']).toBe('Access for Gina')
  expect(tree!.root.findAllByType('select').at(-1)!.props.value).toBe('inherit')
  expect(tree!.root.findAllByType('small').at(-1)!.children).toContain('No access')
  await act(async()=>{tree!.root.findAllByType('select').at(-1)!.props.onChange({target:{value:'view'}})})
  expect(fetcher.mock.calls[3][1].method).toBe('PUT')
  expect(JSON.parse(fetcher.mock.calls[3][1].body)).toMatchObject({orgId:'org',userId:'member-2',permission:'view',version:0})
});
