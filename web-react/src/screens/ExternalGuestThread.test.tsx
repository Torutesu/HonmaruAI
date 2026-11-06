import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {ExternalGuestThread} from './ExternalGuestThread'
const ok=(value:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value})
const thread=(permission:'view'|'edit')=>({permission,thread:{parent:{id:'root',body:'Shared context',authorName:'Owner',mine:false,createdAt:'2026-11-06T00:00:00Z',parentId:null},replies:[]}})
afterEach(()=>vi.unstubAllGlobals())
const props={httpBase:'https://api.example',orgId:'org/one',rootId:'root one',sessionToken:'session'}

test('loads an exact shared Thread and sends an edit reply',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(ok(thread('edit'))).mockResolvedValueOnce(ok({sent:true,messageId:'reply-1'})).mockResolvedValueOnce(ok({...thread('edit'),thread:{...thread('edit').thread,replies:[{id:'reply-1',body:'I will review',authorName:'Guest',mine:true,createdAt:'2026-11-06T00:01:00Z',parentId:'root'}]}}))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalGuestThread {...props}/>);await Promise.resolve();await Promise.resolve()})
 expect(JSON.stringify(tree.toJSON())).toContain('Shared context')
 const input=tree.root.findByType('textarea')
 act(()=>input.props.onChange({target:{value:'I will review'}}))
 await act(async()=>{tree.root.findByType('form').props.onSubmit({preventDefault(){}});await Promise.resolve();await Promise.resolve();await Promise.resolve()})
 expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({body:'I will review'})
 expect(JSON.stringify(tree.toJSON())).toContain('I will review')
 expect(fetch.mock.calls[0][0]).toContain('/external/threads/org%2Fone/root%20one')
 act(()=>tree.unmount())
})

test('view-only guests submit a reply request for owner approval',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(ok(thread('view'))).mockResolvedValueOnce(ok({status:'pending',requestId:'request-1'}))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalGuestThread {...props}/>);await Promise.resolve();await Promise.resolve()})
 act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'Please reply'}}))
 await act(async()=>{tree.root.findByType('form').props.onSubmit({preventDefault(){}});await Promise.resolve();await Promise.resolve()})
 expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({body:'Please reply',requestSend:true})
 expect(JSON.stringify(tree.toJSON())).toContain('Your reply request was sent to the Thread owner.')
 act(()=>tree.unmount())
})
