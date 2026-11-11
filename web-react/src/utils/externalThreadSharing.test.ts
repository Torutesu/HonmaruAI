import { afterEach, expect, test, vi } from 'vitest'
import { ExternalThreadShareError, listExternalThreadShares, revokeExternalThreadShare, shareExternalThread } from './externalThreadSharing'

const api={httpBase:'https://api.example/',orgId:'team:a/b',sessionToken:'session'}
afterEach(()=>vi.unstubAllGlobals())
const response=(value:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value})

test('lists active collaborator grants from the exact external Thread endpoint',async()=>{
 const grant={id:'grant-1',permission:'view',recipient:{name:'Ari',email:'ari@example.com'},grantedAt:'2026-11-06T00:00:00Z',expiresAt:null}
 const fetch=vi.fn().mockResolvedValue(response({shares:[grant]}));vi.stubGlobal('fetch',fetch)
 await expect(listExternalThreadShares(api,'root /?')).resolves.toEqual([grant])
 expect(fetch).toHaveBeenCalledWith('https://api.example/external/threads/team%3Aa%2Fb/root%20%2F%3F/shares',expect.objectContaining({method:'GET',headers:{'x-session-token':'session'},cache:'no-store'}))
})

test('shares with permission and expiry and revokes the named recipient',async()=>{
 const grant={id:'grant-2',permission:'edit',expiresAt:'2026-12-01T00:00:00.000Z'}
 const fetch=vi.fn().mockResolvedValueOnce(response({grant,recipient:{name:'Ari',email:'ari@example.com'}})).mockResolvedValueOnce(response({revoked:true}))
 vi.stubGlobal('fetch',fetch)
 const saved=await shareExternalThread(api,'root',{email:'ari@example.com',permission:'edit',expiresAt:grant.expiresAt})
 expect(saved).toMatchObject({...grant,recipient:{name:'Ari',email:'ari@example.com'}})
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({email:'ari@example.com',permission:'edit',expiresAt:grant.expiresAt})
 await expect(revokeExternalThreadShare(api,'root','grant-2')).resolves.toBe(true)
 expect(fetch.mock.calls[1][1]).toMatchObject({method:'DELETE',body:JSON.stringify({grantId:'grant-2'})})
})

test('shares with a selected collaborator id without sending an email address',async()=>{
 const grant={id:'grant-3',permission:'view',expiresAt:null}
 const fetch=vi.fn().mockResolvedValue(response({grant,recipient:{name:'Ari',email:'ari@example.com'}}));vi.stubGlobal('fetch',fetch)
 await expect(shareExternalThread(api,'root',{recipientGithubId:'guest-3',permission:'view',expiresAt:null})).resolves.toMatchObject({id:'grant-3',recipient:{email:'ari@example.com'}})
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({recipientGithubId:'guest-3',permission:'view',expiresAt:null})
})

test('preserves authorization errors for the dialog',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({message:'Thread not found.'},404)))
 await expect(listExternalThreadShares(api,'root')).rejects.toMatchObject<Partial<ExternalThreadShareError>>({status:404,message:'Thread not found.'})
})

test('creates, lists, and revokes email-bound invitation links without sending mail',async()=>{
 const fetch=vi.fn()
  .mockResolvedValueOnce(response({invited:true,invitationId:'invite-1',inviteUrl:'https://app.example/#/external-invite/secret',expiresAt:'2026-11-13T00:00:00Z'}))
  .mockResolvedValueOnce(response({invitations:[{id:'invite-1',email:'guest@example.com',permission:'view'}]}))
  .mockResolvedValueOnce(response({revoked:true}))
 vi.stubGlobal('fetch',fetch)
 const sharing=await import('./externalThreadSharing')
 await expect(sharing.createExternalThreadInvitation(api,'root',{email:'guest@example.com',permission:'view',accessExpiresAt:null})).resolves.toMatchObject({invitationId:'invite-1',inviteUrl:'https://app.example/#/external-invite/secret'})
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({email:'guest@example.com',permission:'view',accessExpiresAt:null})
 await expect(sharing.listExternalThreadInvitations(api,'root')).resolves.toMatchObject([{id:'invite-1',email:'guest@example.com'}])
 await expect(sharing.revokeExternalThreadInvitation(api,'root','invite-1')).resolves.toBe(true)
 expect(fetch.mock.calls[2][0]).toContain('/invites/invite-1')
 expect(fetch.mock.calls[2][1].method).toBe('DELETE')
})
