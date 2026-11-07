import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { AppSharing } from './AppSharing'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
let tree: ReactTestRenderer | undefined
afterEach(() => { act(() => tree?.unmount()); vi.unstubAllGlobals() })
const props = { httpBase: 'https://test.local', orgId: 'org', sessionToken: 'session', appId: 'app', appVersion: 4 }

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

test('room audience retains person overrides and saves a versioned room scope', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ access:{visibility:'workspace',version:2},canEdit:true,rooms:['b:ops'],people:[{userId:'2',login:'mika',name:'Mika',permission:'view',explicit:true,role:'member'}] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ access:{visibility:'room',roomChannel:'b:ops',version:3},people:[{userId:'2',login:'mika',name:'Mika',permission:'view',explicit:true,role:'member'}] })))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => { tree = create(<AppSharing {...props} />) })
  await act(async () => { tree!.root.findAllByType('select')[0].props.onChange({target:{value:'room'}}) })
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({orgId:'org',visibility:'room',channel:'b:ops',version:2,people:[{userId:'2',permission:'view'}]})
})

test('public app link creation and revocation use pinned app and audience versions', async () => {
  const token='app_'+'a'.repeat(64)
  const fetcher=vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({access:{visibility:'workspace',version:8},canManage:true,canPublicShare:true,rooms:[],people:[]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({shares:[]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({requests:[]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({share:{id:'share-1'},token}),{status:201}))
    .mockResolvedValueOnce(new Response(JSON.stringify({shares:[{id:'share-1',createdAt:'2026-11-06T00:00:00.000Z',expiresAt:'2026-11-13T00:00:00.000Z',revokedAt:null}]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({revoked:true})))
    .mockResolvedValueOnce(new Response(JSON.stringify({shares:[{id:'share-1',createdAt:'2026-11-06T00:00:00.000Z',expiresAt:'2026-11-13T00:00:00.000Z',revokedAt:'2026-11-06T00:01:00.000Z'}]})))
  vi.stubGlobal('location',{origin:'https://app.test'}); vi.stubGlobal('fetch',fetcher)
  await act(async()=>{tree=create(<AppSharing {...props}/>)} )
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

test('Agent approval changes request status without manufacturing a bearer link', async () => {
  const request={id:'request-1',requesterLogin:'mika',agentId:'agent-review',roomChannel:'b:review',appVersion:4,accessVersion:8,status:'pending',createdAt:'2026-11-06T00:00:00.000Z'}
  const fetcher=vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({access:{visibility:'room',roomChannel:'b:review',version:8},canEdit:true,canManage:true,canPublicShare:true,rooms:['b:review'],people:[]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({shares:[]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({requests:[request]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({requestId:'request-1',status:'approved',tokenCreated:false})))
    .mockResolvedValueOnce(new Response(JSON.stringify({requests:[{...request,status:'approved'}]})))
  vi.stubGlobal('location',{origin:'https://app.test'}); vi.stubGlobal('fetch',fetcher)
  await act(async()=>{tree=create(<AppSharing {...props}/>)} )
  const approve=tree!.root.findAllByType('button').find(button=>button.children.includes('Approve'))!
  await act(async()=>{await approve.props.onClick()})
  expect(fetcher.mock.calls[3][0]).toContain('/public-share-approvals?')
  expect(JSON.parse(fetcher.mock.calls[3][1].body)).toMatchObject({orgId:'org',requestId:'request-1',decision:'approve'})
  expect(tree!.root.findAllByType('a').some(link=>String(link.props.href).includes('/app-share/'))).toBe(false)
})
