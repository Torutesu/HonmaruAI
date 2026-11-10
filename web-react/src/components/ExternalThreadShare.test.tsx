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
const noRequests=()=>ok({requests:[]})
const noLinks=()=>ok({links:[]})
const noAudience=()=>ok({audience:null,version:1,rooms:[{id:'room-design',name:'Design'}]})
type TestFetchInit={method:string;body?:string}
type TestFetch=ReturnType<typeof vi.fn<(url:string,init:TestFetchInit)=>Promise<any>>>
const fetchReplies=(normal:any[],audiences:any[]=[noAudience()]):TestFetch=>{
 const pending=[...normal],audiencePending=[...audiences]
 let lastAudience=noAudience()
 return vi.fn((url:string,init:TestFetchInit)=>{
  if(String(url).endsWith('/audience')&&init.method!=='PUT'){
   lastAudience=audiencePending.shift()||lastAudience
   return Promise.resolve(lastAudience)
  }
  return Promise.resolve(pending.shift()||empty())
 })
}
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()}
afterEach(()=>vi.unstubAllGlobals())

test('shows named active grants and revoke refreshes the list',async()=>{
 const fetch=fetchReplies([ok({shares:[grant]}),noInvites(),noRequests(),noLinks(),ok({revoked:true}),empty(),noInvites(),noRequests(),noLinks()])
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await flush()})
 expect(JSON.stringify(tree.toJSON())).toContain('Ari')
 expect(JSON.stringify(tree.toJSON())).toContain('ari@example.com')
 await act(async()=>{tree.root.findAllByType('button').find(b=>b.children.includes('Revoke access'))!.props.onClick();await flush()})
 expect(fetch.mock.calls.map(call=>call[1].method)).toEqual(['GET','GET','GET','GET','GET','DELETE','GET','GET','GET','GET','GET'])
 expect(JSON.stringify(tree.toJSON())).toContain('No one outside this workspace has access.')
 act(()=>tree.unmount())
})

test('creates and copies a named expiring invite link, and lists pending invites',async()=>{
 const invitation={id:'invite-1',email:'guest@example.com',permission:'edit',createdAt:'2026-11-06T00:00:00Z',expiresAt:'2026-11-13T00:00:00Z',accessExpiresAt:null}
 const fetch=fetchReplies([empty(),noInvites(),noRequests(),noLinks(),ok({invited:true,invitationId:'invite-1',inviteUrl:'https://app.example/#/external-invite/secret',expiresAt:invitation.expiresAt}),empty(),ok({invitations:[invitation]}),noRequests(),noLinks()])
 vi.stubGlobal('fetch',fetch)
 const writeText=vi.fn().mockResolvedValue(undefined)
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}})
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await flush()})
 const email=tree.root.findAllByType('form')[2].findByType('input')
 act(()=>email.props.onChange({target:{value:'guest@example.com'}}))
 const selects=tree.root.findAllByType('select')
 act(()=>selects.find(select=>select.props['aria-label']==='Invite permission')!.props.onChange({target:{value:'edit'}}))
 act(()=>selects.find(select=>select.props['aria-label']==='Invite expiry')!.props.onChange({target:{value:'7d'}}))
 await act(async()=>{tree.root.findAllByType('form')[2].props.onSubmit({preventDefault(){}});await flush()})
 const inviteRequest=fetch.mock.calls.find(([url,init])=>String(url).includes('/invites')&&init?.method==='POST')
 expect(inviteRequest).toBeDefined()
 expect(JSON.parse(inviteRequest![1].body!)).toMatchObject({email:'guest@example.com',permission:'edit'})
 expect(JSON.stringify(tree.toJSON())).toContain('guest@example.com')
 expect(JSON.stringify(tree.toJSON())).toContain('https://app.example/#/external-invite/secret')
 await act(async()=>{tree.root.findAllByType('button').find(button=>button.children.includes('Copy link'))!.props.onClick();await flush()})
 expect(writeText).toHaveBeenCalledWith('https://app.example/#/external-invite/secret')
 act(()=>tree.unmount())
})

test('creates a reusable anyone-with-link share and can revoke the active link',async()=>{
 const link={id:'link-1',permission:'edit',createdAt:'2026-11-06T00:00:00Z',expiresAt:'2026-12-06T00:00:00Z'}
 const fetch=fetchReplies([empty(),noInvites(),noRequests(),noLinks(),ok({created:true,link,inviteUrl:'https://app.example/#/external-invite/token'}),empty(),noInvites(),noRequests(),ok({links:[link]}),ok({revoked:true}),empty(),noInvites(),noRequests(),noLinks()])
 vi.stubGlobal('fetch',fetch)
 const writeText=vi.fn().mockResolvedValue(undefined)
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}})
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await flush()})
 expect(JSON.stringify(tree.toJSON())).toContain('Anyone with the link')
 const selects=tree.root.findAllByType('select')
 act(()=>selects.find(s=>s.props['aria-label']==='Link permission')!.props.onChange({target:{value:'edit'}}))
 await act(async()=>{tree.root.findAllByType('form')[1].props.onSubmit({preventDefault(){}});await flush()})
 expect(JSON.stringify(tree.toJSON())).toContain('https://app.example/#/external-invite/token')
 const createLinkRequest=fetch.mock.calls.find(([url,init])=>String(url).endsWith('/links')&&init.method==='POST')
 expect(JSON.parse(createLinkRequest![1].body!)).toMatchObject({permission:'edit'})
 await act(async()=>{tree.root.findAllByType('button').find(b=>b.children.includes('Copy link'))!.props.onClick();await flush()})
 expect(writeText).toHaveBeenCalledWith('https://app.example/#/external-invite/token')
 await act(async()=>{tree.root.findAllByType('button').find(b=>b.children.includes('Revoke link'))!.props.onClick();await flush()})
 expect(fetch.mock.calls.find(([url,init])=>String(url).endsWith('/links/link-1')&&init.method==='DELETE')?.[0]).toContain('/links/link-1')
 act(()=>tree.unmount())
})

test('shows a workspace member paused grant and still lets the owner revoke it by grant id',async()=>{
 const memberGrant={...grant,recipientIsMember:true,suspended:true}
 const fetch=fetchReplies([ok({shares:[memberGrant]}),noInvites(),noRequests(),noLinks(),ok({revoked:true}),empty(),noInvites(),noRequests(),noLinks()])
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await flush()})
 expect(JSON.stringify(tree.toJSON())).toContain('Workspace member')
 expect(JSON.stringify(tree.toJSON())).toContain('External grant is paused while this person is a workspace member.')
 expect(tree.root.findAllByType('select').find(s=>s.props['aria-label']==='Permission for ari@example.com')!.props.disabled).toBe(true)
 const revoke=tree.root.findAllByType('button').find(button=>button.children.includes('Revoke access'))!
 expect(revoke.props.disabled).toBe(false)
 await act(async()=>{revoke.props.onClick();await flush()})
 const revokeRequest=fetch.mock.calls.find(([url,init])=>String(url).endsWith('/shares')&&init.method==='DELETE')
 expect(JSON.parse(revokeRequest![1].body!)).toEqual({grantId:'grant-1'})
 act(()=>tree.unmount())
})

test('saves the selected Room audience with permission, expiry, and the current version',async()=>{
 const roomAudience={type:'room',roomId:'room-design',permission:'edit',expiresAt:'2026-12-06T00:00:00.000Z',version:8}
 const fetch=fetchReplies([empty(),noInvites(),noRequests(),noLinks(),ok({saved:true}),empty(),noInvites(),noRequests(),noLinks()],[noAudience(),ok({audience:roomAudience,version:8,rooms:[{id:'room-design',name:'Design'}]})])
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await flush()})
 const selects=tree.root.findAllByType('select')
 act(()=>selects.find(select=>select.props['aria-label']==='Sharing')!.props.onChange({target:{value:'room'}}))
 act(()=>tree.root.findAllByType('select').find(select=>select.props['aria-label']==='Room')!.props.onChange({target:{value:'room-design'}}))
 act(()=>tree.root.findAllByType('select').find(select=>select.props['aria-label']==='Permission · Sharing')!.props.onChange({target:{value:'edit'}}))
 act(()=>tree.root.findAllByType('select').find(select=>select.props['aria-label']==='Expires · Sharing')!.props.onChange({target:{value:'30d'}}))
 await act(async()=>{tree.root.findAllByType('button').find(button=>button.children.includes('Save'))!.props.onClick();await flush()})
 const request=fetch.mock.calls.find(([url,init])=>String(url).endsWith('/audience')&&init.method==='PUT')
 expect(request).toBeDefined()
 const body=JSON.parse(request![1].body!)
 expect(body).toMatchObject({version:1,type:'room',roomId:'room-design',permission:'edit'})
 expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now()+29*86400000)
 expect(JSON.stringify(tree.toJSON())).toContain('Design')
 expect(JSON.stringify(tree.toJSON())).toContain('Can edit')
 act(()=>tree.unmount())
})

test('a 409 offers reload, refreshes the audience version, and revokes the fresh setting',async()=>{
 const roomAudience={type:'room',roomId:'room-design',permission:'view',expiresAt:null,version:2}
 const workspaceAudience={type:'workspace',permission:'edit',expiresAt:null,version:3}
 const fetch=fetchReplies([empty(),noInvites(),noRequests(),noLinks(),ok({message:'changed'},409),empty(),noInvites(),noRequests(),noLinks(),ok({cleared:true}),empty(),noInvites(),noRequests(),noLinks()],[ok({audience:roomAudience,version:2,rooms:[{id:'room-design',name:'Design'}]}),ok({audience:workspaceAudience,version:3,rooms:[{id:'room-design',name:'Design'}]}),ok({audience:null,version:4,rooms:[{id:'room-design',name:'Design'}]})])
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await flush()})
 await act(async()=>{tree.root.findAllByType('button').find(button=>button.children.includes('Save'))!.props.onClick();await flush()})
 expect(JSON.stringify(tree.toJSON())).toContain('Room settings or membership changed. Reload before saving.')
 const reload=tree.root.findAllByType('button').find(button=>button.children.includes('Reload'))!
 expect(reload).toBeDefined()
 await act(async()=>{reload.props.onClick();await flush()})
 expect(tree.root.findAllByType('select').find(select=>select.props['aria-label']==='Sharing')!.props.value).toBe('workspace')
 expect(JSON.stringify(tree.toJSON())).toContain('Workspace members')
 await act(async()=>{tree.root.findAllByType('button').find(button=>button.children.includes('Revoke access'))!.props.onClick();await flush()})
 const writes=fetch.mock.calls.filter(([url,init])=>String(url).endsWith('/audience')&&init.method==='PUT')
 expect(writes.map(call=>JSON.parse(call[1].body!))).toEqual([
  {version:2,type:'room',roomId:'room-design',permission:'view',expiresAt:null},
  {version:3,type:null},
 ])
 act(()=>tree.unmount())
})

test('owner can approve or decline pending guest replies and the list refreshes',async()=>{
 const pending={id:'request-1',body:'Please share the update',requested_at:'2026-11-06T10:00:00Z',guest_name:'Ari Guest',guest_email:'guest@example.com'}
 const fetch=fetchReplies([empty(),noInvites(),ok({requests:[pending]}),noLinks(),ok({approved:true}),empty(),noInvites(),ok({requests:[]}),noLinks()])
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalThreadShare api={api} threadId="root" onClose={()=>{}}/>);await flush()})
 expect(JSON.stringify(tree.toJSON())).toContain('Please share the update')
 await act(async()=>{tree.root.findAllByType('button').find(b=>b.children.includes('Approve'))!.props.onClick();await flush()})
 const decision=fetch.mock.calls.find(([url,init])=>String(url).endsWith('/requests/approve')&&init.method==='POST')
 expect(decision).toBeDefined()
 expect(JSON.parse(decision![1].body!)).toEqual({requestId:'request-1'})
 expect(JSON.stringify(tree.toJSON())).toContain('No pending guest reply requests.')
 act(()=>tree.unmount())
})
