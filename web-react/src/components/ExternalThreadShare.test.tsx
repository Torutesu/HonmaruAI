import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {ExternalThreadShare} from './ExternalThreadShare'
vi.mock('./Dialog',()=>({Dialog:({children,title,footer}:any)=><section aria-label={title}>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=>((text:string)=>text)}))
const api={httpBase:'https://api.example',orgId:'team:test',sessionToken:'token'}
const grant={id:'grant-1',permission:'view',recipient:{name:'Ari',email:'ari@example.com'},grantedAt:'2026-11-06T00:00:00Z',expiresAt:null}
const ok=(value:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value})
const empty=()=>ok({shares:[]})
const noInvites=()=>ok({invitations:[]})
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()}
afterEach(()=>vi.unstubAllGlobals())

test('shows named active grants and revoke refreshes the list',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(ok({shares:[grant]})).mockResolvedValueOnce(noInvites()).mockResolvedValueOnce(ok({revoked:true})).mockResolvedValueOnce(empty()).mockResolvedValueOnce(noInvites())
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await flush()})
 expect(JSON.stringify(tree.toJSON())).toContain('Ari')
 expect(JSON.stringify(tree.toJSON())).toContain('ari@example.com')
 await act(async()=>{tree.root.findAllByType('button').find(b=>b.children.includes('Revoke access'))!.props.onClick();await flush()})
 expect(fetch.mock.calls.map(call=>call[1].method)).toEqual(['GET','GET','DELETE','GET','GET'])
 expect(JSON.stringify(tree.toJSON())).toContain('No one outside this workspace has access.')
 act(()=>tree.unmount())
})

test('creates and copies a named expiring invite link, and lists pending invites',async()=>{
 const invitation={id:'invite-1',email:'guest@example.com',permission:'edit',createdAt:'2026-11-06T00:00:00Z',expiresAt:'2026-11-13T00:00:00Z',accessExpiresAt:null}
 const fetch=vi.fn().mockResolvedValueOnce(empty()).mockResolvedValueOnce(noInvites()).mockResolvedValueOnce(ok({invited:true,invitationId:'invite-1',inviteUrl:'https://app.example/#/external-invite/secret',expiresAt:invitation.expiresAt})).mockResolvedValueOnce(empty()).mockResolvedValueOnce(ok({invitations:[invitation]}))
 vi.stubGlobal('fetch',fetch)
 const writeText=vi.fn().mockResolvedValue(undefined)
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}})
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await flush()})
 const email=tree.root.findAllByType('input').find(input=>input.props.type==='email')!
 act(()=>email.props.onChange({target:{value:'guest@example.com'}}))
 const selects=tree.root.findAllByType('select')
 act(()=>selects.find(select=>select.props['aria-label']==='Invite permission')!.props.onChange({target:{value:'edit'}}))
 act(()=>selects.find(select=>select.props['aria-label']==='Invite expiry')!.props.onChange({target:{value:'7d'}}))
 await act(async()=>{tree.root.findAllByType('form')[1].props.onSubmit({preventDefault(){}});await flush()})
 const inviteRequest=fetch.mock.calls.find(([url,init])=>init?.method==='POST')
 if(!inviteRequest)throw new Error(`Invite request missing; calls=${JSON.stringify(fetch.mock.calls)}`)
 expect(JSON.parse(inviteRequest![1].body)).toMatchObject({email:'guest@example.com',permission:'edit'})
 expect(JSON.stringify(tree.toJSON())).toContain('guest@example.com')
 expect(JSON.stringify(tree.toJSON())).toContain('https://app.example/#/external-invite/secret')
 await act(async()=>{tree.root.findAllByType('button').find(button=>button.children.includes('Copy link'))!.props.onClick();await flush()})
 expect(writeText).toHaveBeenCalledWith('https://app.example/#/external-invite/secret')
 act(()=>tree.unmount())
})

test('shows a workspace member paused grant and still lets the owner revoke it by grant id',async()=>{
 const memberGrant={...grant,recipientIsMember:true,suspended:true}
 const fetch=vi.fn().mockResolvedValueOnce(ok({shares:[memberGrant]})).mockResolvedValueOnce(noInvites()).mockResolvedValueOnce(ok({revoked:true})).mockResolvedValueOnce(empty()).mockResolvedValueOnce(noInvites())
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await flush()})
 expect(JSON.stringify(tree.toJSON())).toContain('Workspace member')
 expect(JSON.stringify(tree.toJSON())).toContain('External grant is paused while this person is a workspace member.')
 expect(tree.root.findAllByType('select').find(s=>s.props['aria-label']==='Permission for ari@example.com')!.props.disabled).toBe(true)
 const revoke=tree.root.findAllByType('button').find(button=>button.children.includes('Revoke access'))!
 expect(revoke.props.disabled).toBe(false)
 await act(async()=>{revoke.props.onClick();await flush()})
 expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({grantId:'grant-1'})
 act(()=>tree.unmount())
})
