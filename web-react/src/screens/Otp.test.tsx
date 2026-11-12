import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { Otp } from './Otp'

vi.mock('../utils/i18n', () => ({ useT: () => (value: string) => value }))
const response = (body: unknown) => ({ ok: true, json: async () => body })
afterEach(() => vi.unstubAllGlobals())

test('redeems an external Thread invite with the session created by email OTP', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(response({ token: 'session-token', userId: 'email:guest@example.test', orgId: 'personal', created: true }))
    .mockResolvedValueOnce(response({ redeemed: true, orgId: 'team:one', resourceType: 'thread', resourceId: 'root', permission: 'view' }))
  vi.stubGlobal('fetch', fetch)
  const onVerified = vi.fn()
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(<Otp
      httpBase="https://api.example"
      email="guest@example.test"
      name="Guest"
      inviteCode=""
      externalInviteToken={"a".repeat(64)}
      onVerified={onVerified}
      onBack={() => {}}
    />)
  })
  await act(async () => {
    tree.root.findAllByProps({ inputMode: 'numeric' })[0].props.onChange({ target: { value: '382941' } })
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[0][0]).toBe('https://api.example/auth/otp/verify')
  expect(fetch.mock.calls[1][0]).toBe('https://api.example/external/invites/redeem')
  expect(fetch.mock.calls[1][1]).toMatchObject({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'session-token' },
  })
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ token: 'a'.repeat(64) })
  expect(onVerified).toHaveBeenCalledWith(
    'session-token',
    'email:guest@example.test',
    'personal',
    true,
    { message: 'The Thread invitation was accepted.', externalThread: { orgId: 'team:one', rootId: 'root', permission: 'view' } },
  )
  act(() => tree.unmount())
})

test('passes a redeemed App link back to authentication routing',async()=>{
 const fetch=vi.fn()
  .mockResolvedValueOnce(response({token:'session-token',userId:'guest',orgId:'personal',created:true}))
  .mockResolvedValueOnce(response({redeemed:true,orgId:'team:one',resourceType:'app',appId:'app/one',permission:'view'}))
 vi.stubGlobal('fetch',fetch);const onVerified=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<Otp httpBase="https://api.example" email="guest@example.test" name="Guest" inviteCode="" externalInviteToken={'b'.repeat(64)} onVerified={onVerified} onBack={()=>{}}/>)} )
 await act(async()=>{tree.root.findAllByProps({inputMode:'numeric'})[0].props.onChange({target:{value:'382941'}});for(let i=0;i<8;i++)await Promise.resolve()})
 expect(onVerified).toHaveBeenCalledWith('session-token','guest','personal',true,{message:'The App invitation was accepted.',externalApp:{orgId:'team:one',appId:'app/one'}})
 act(()=>tree.unmount())
})
