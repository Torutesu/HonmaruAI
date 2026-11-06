import {expect,test} from 'vitest'
import {externalThreadAccessFromInvite,externalThreadHash} from './externalThreadInvite'

test('routes a successful named guest redemption to its exact Thread',()=>{
 const access=externalThreadAccessFromInvite({redeemed:true,orgId:'team:a/b',resourceType:'thread',resourceId:'root /one',permission:'view'})
 expect(access).toEqual({orgId:'team:a/b',rootId:'root /one',permission:'view'})
 expect(externalThreadHash(access!)).toBe('#/external-thread/team%3Aa%2Fb/root%20%2Fone')
})

test('does not route failed, member, or malformed redemption responses',()=>{
 expect(externalThreadAccessFromInvite({redeemed:false,orgId:'team:a',resourceType:'thread',resourceId:'root',permission:'view'})).toBeNull()
 expect(externalThreadAccessFromInvite({redeemed:true,alreadyMember:true,orgId:'team:a'})).toBeNull()
 expect(externalThreadAccessFromInvite({redeemed:true,orgId:'team:a',resourceType:'workflow',resourceId:'root',permission:'edit'})).toBeNull()
})
