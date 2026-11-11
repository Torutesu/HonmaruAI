import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ExternalAppSharing } from './ExternalAppSharing'

vi.mock('../utils/i18n', () => ({ useT: () => (text: string, vars?: Record<string, string | number>) => Object.entries(vars || {}).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), text) }))
let tree: ReactTestRenderer | undefined
let requests: Array<{ url: string; init?: RequestInit }> = []
let manager = true
beforeEach(() => {
  requests = []
  manager = true
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init })
    if (url.endsWith('/sharing') && init?.method === 'POST') {
      return new Response(JSON.stringify({ invite: { token: 'a'.repeat(64), emailDelivery: { status: 'not_configured' } } }), { status: 201 })
    }
    if (url.includes('/external/collaborators/search')) return new Response(JSON.stringify({ people: [{ githubId:'guest-2',login:'ari',name:'Ari' }] }), { status:200 })
    if (url.endsWith('/sharing/requests')) return new Response(JSON.stringify({ requests: [
      { id: 'request-1', tableId: '', rowId: '', guestGithubId: 'guest-1', name: 'Guest Person', login: 'guest', email: 'guest@example.com', body: 'Please confirm this update.', requestedAt: '2026-11-07T10:00:00.000Z' },
    ] }), { status: 200 })
    if (url.endsWith('/sharing') && !manager) return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 })
    if (url.endsWith('/sharing')) return new Response(JSON.stringify({
      canManage: true,
      guests: [{ githubId: 'guest-1', login: 'guest', name: 'Guest Person', email: 'guest@example.com', permission: 'view', expiresAt: null }],
      invites: [{ id: 'invite-1', invitedEmail: 'pending@example.com', permission: 'view', accessExpiresAt: null, inviteExpiresAt: '2026-11-14T00:00:00.000Z' }],
    }), { status: 200 })
    return new Response(JSON.stringify({ updated: true, revoked: true }), { status: 200 })
  }))
})
afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const props = { httpBase: 'https://api.example', orgId: 'org-1', sessionToken: 'session', appId: 'app-1' }

test('App owner can invite a named guest, approve a message, change permission and revoke access', async () => {
  await act(async () => { tree = create(<ExternalAppSharing {...props} />) })
  expect(JSON.stringify(tree?.toJSON())).toContain('External guests')
  const email = tree!.root.findByProps({ 'aria-label': 'Guest email' })
  await act(async () => { email.props.onChange({ target: { value: 'new@example.com' } }) })
  const permission = tree!.root.findByProps({ 'aria-label': 'Guest permission' })
  await act(async () => { permission.props.onChange({ target: { value: 'edit' } }) })
  const inviteExpiry = tree!.root.findByProps({ 'aria-label': 'Guest access expiry' })
  await act(async () => { inviteExpiry.props.onChange({ target: { value: '7' } }) })
  await act(async () => { tree!.root.findByType('form').props.onSubmit({ preventDefault() {} }) })
  const inviteRequest = requests.find(item => item.url.endsWith('/sharing') && item.init?.method === 'POST')
  const inviteBody = JSON.parse(String(inviteRequest?.init?.body))
  expect(inviteBody).toMatchObject({ email: 'new@example.com', permission: 'edit' })
  expect(Date.parse(inviteBody.expiresAt)).toBeGreaterThan(Date.now())
  expect(JSON.stringify(tree?.toJSON())).toContain('Email delivery is not configured')
  expect(JSON.stringify(tree?.toJSON())).toContain('one-time link')
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const copyButton = tree!.root.findAllByType('button').find(button => String(button.children.join('')).includes('Copy link'))
  expect(copyButton).toBeTruthy()
  await act(async () => { copyButton!.props.onClick() })
  expect(writeText).toHaveBeenCalledWith(tree!.root.findByProps({ 'aria-label': 'One-time invite link' }).props.value)
  expect(JSON.stringify(tree?.toJSON())).toContain('Invite link copied.')
  const approvalButton = tree!.root.findAllByType('button').find(button => String(button.children.join('')).includes('Approve message'))
  expect(approvalButton).toBeTruthy()
  await act(async () => { approvalButton!.props.onClick() })
  expect(requests.some(item => item.url.endsWith('/sharing/requests/request-1') && item.init?.method === 'POST' && JSON.parse(String(item.init.body)).decision === 'approve')).toBe(true)
  const grantPermission = tree!.root.findByProps({ 'aria-label': 'Permission for Guest Person' })
  await act(async () => { grantPermission.props.onChange({ target: { value: 'edit' } }) })
  const expiryControl = tree!.root.findByProps({ 'aria-label': 'Access expiry for Guest Person' })
  await act(async () => { expiryControl.props.onChange({ target: { value: '30' } }) })
  const guestPatches = requests.filter(item => item.url.endsWith('/guest-1') && item.init?.method === 'PATCH')
  expect(guestPatches.length).toBeGreaterThanOrEqual(2)
  expect(Date.parse(JSON.parse(String(guestPatches[1].init?.body)).expiresAt)).toBeGreaterThan(Date.now())
  const revokeButtons = tree!.root.findAllByType('button').filter(button => String(button.children.join('')).includes('Revoke'))
  expect(revokeButtons.length).toBeGreaterThanOrEqual(2)
  await act(async () => { revokeButtons[0].props.onClick() })
  await act(async () => { revokeButtons[1].props.onClick() })
  expect(requests.filter(item => item.init?.method === 'DELETE')).toHaveLength(2)
})

test('non-managers cannot see external guest controls', async () => {
  manager = false
  await act(async () => { tree = create(<ExternalAppSharing {...props} />) })
  expect(JSON.stringify(tree?.toJSON()) || '').not.toContain('External guests')
  expect(tree!.root.findAllByType('form')).toHaveLength(0)
})

test('App owner can share directly with a selected external collaborator',async()=>{
 vi.useFakeTimers()
 await act(async()=>{tree=create(<ExternalAppSharing {...props}/>);await Promise.resolve()})
 await act(async()=>{tree!.root.findAllByType('input')[0].props.onChange({target:{value:'Ari'}});await vi.advanceTimersByTimeAsync(250)})
 await act(async()=>{tree!.root.findByProps({role:'option'}).props.onClick()})
 const shareButton=tree!.root.findAllByType('button').find(button=>String(button.children.join(''))==='Share with person')
 await act(async()=>{shareButton!.props.onClick();await Promise.resolve()})
 const post=requests.find(item=>item.url.endsWith('/sharing')&&item.init?.method==='POST')
 expect(JSON.parse(String(post?.init?.body))).toMatchObject({recipientGithubId:'guest-2',permission:'view'})
 expect(JSON.stringify(tree?.toJSON())).toContain('Guest Person')
})
