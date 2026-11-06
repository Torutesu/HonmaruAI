import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {ExternalThreadShare} from './ExternalThreadShare'
vi.mock('./Dialog',()=>({Dialog:({children,title,footer}:any)=><section aria-label={title}>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=>((text:string)=>text)}))
const api={httpBase:'https://api.example',orgId:'team:test',sessionToken:'token'}
const grant={id:'grant-1',permission:'view',recipient:{name:'Ari',email:'ari@example.com'},grantedAt:'2026-11-06T00:00:00Z',expiresAt:null}
const ok=(value:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value})
afterEach(()=>vi.unstubAllGlobals())

test('shows named active grants and revoke refreshes the list',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(ok({shares:[grant]})).mockResolvedValueOnce(ok({revoked:true})).mockResolvedValueOnce(ok({shares:[]}))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await Promise.resolve()})
 expect(JSON.stringify(tree.toJSON())).toContain('Ari')
 expect(JSON.stringify(tree.toJSON())).toContain('ari@example.com')
 await act(async()=>{tree.root.findAllByType('button').find(b=>b.children.includes('Revoke access'))!.props.onClick();await Promise.resolve();await Promise.resolve()})
 expect(fetch.mock.calls.map(call=>call[1].method)).toEqual(['GET','DELETE','GET'])
 expect(JSON.stringify(tree.toJSON())).toContain('No one outside this workspace has access.')
 act(()=>tree.unmount())
})

test('adds an email recipient with a named permission and expiry',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(ok({shares:[]})).mockResolvedValueOnce(ok({grant:{id:'grant-2',permission:'edit',expiresAt:'2026-12-06T00:00:00Z'},recipient:{name:'Bea',email:'bea@example.com'}})).mockResolvedValueOnce(ok({shares:[{...grant,id:'grant-2',permission:'edit',recipient:{name:'Bea',email:'bea@example.com'},expiresAt:'2026-12-06T00:00:00Z'}]}))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await Promise.resolve()})
 const email=tree.root.findByProps({type:'email'})
 act(()=>email.props.onChange({target:{value:'bea@example.com'}}))
 const selects=tree.root.findAllByType('select')
 act(()=>selects[0].props.onChange({target:{value:'edit'}}))
 act(()=>selects[1].props.onChange({target:{value:'30d'}}))
 await act(async()=>tree.root.findAllByType('form')[0].props.onSubmit({preventDefault(){}}))
 expect(fetch.mock.calls[1][1].method).toBe('POST')
 const body=JSON.parse(fetch.mock.calls[1][1].body)
 expect(body).toMatchObject({email:'bea@example.com',permission:'edit'})
 expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
 expect(JSON.stringify(tree.toJSON())).toContain('Bea')
 act(()=>tree.unmount())
})


test('shows a workspace member paused grant and still lets the owner revoke it',async()=>{
 const memberGrant={...grant,recipientIsMember:true,suspended:true}
 const fetch=vi.fn().mockResolvedValueOnce(ok({shares:[memberGrant]})).mockResolvedValueOnce(ok({revoked:true})).mockResolvedValueOnce(ok({shares:[]}))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await Promise.resolve()})
 expect(JSON.stringify(tree.toJSON())).toContain('Workspace member')
 expect(JSON.stringify(tree.toJSON())).toContain('External grant is paused while this person is a workspace member.')
 expect(tree.root.findAllByType('select')[0].props.disabled).toBe(true)
 const revoke=tree.root.findAllByType('button').find(button=>button.children.includes('Revoke access'))!
 expect(revoke.props.disabled).toBe(false)
 await act(async()=>{revoke.props.onClick();await Promise.resolve();await Promise.resolve()})
 expect(fetch.mock.calls.map(call=>call[1].method)).toEqual(['GET','DELETE','GET'])
 expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({grantId:'grant-1'})
 act(()=>tree.unmount())
})
