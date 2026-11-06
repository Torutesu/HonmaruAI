import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {ExternalGuestThread} from './ExternalGuestThread'
const ok=(value:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value})
const thread=(permission:'view'|'edit')=>({permission,thread:{parent:{id:'root',body:'Shared context',authorName:'Owner',mine:false,createdAt:'2026-11-06T00:00:00Z',parentId:null},replies:[]}})
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
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


test('refreshes async replies while visible and removes Thread content after access is revoked',async()=>{
 vi.useFakeTimers()
 const reply={id:'reply-ai',body:'The AI finished the answer',authorName:'Honmaru AI',mine:false,createdAt:'2026-11-06T00:02:00Z',parentId:'root'}
 const updated={...thread('edit'),thread:{...thread('edit').thread,replies:[reply]}}
 const fetch=vi.fn().mockResolvedValueOnce(ok(thread('edit'))).mockResolvedValueOnce(ok(updated)).mockResolvedValueOnce(ok({message:'not found'},404))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalGuestThread {...props}/>);await Promise.resolve();await Promise.resolve()})
 expect(JSON.stringify(tree.toJSON())).toContain('Shared context')
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
 expect(JSON.stringify(tree.toJSON())).toContain('The AI finished the answer')
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
 expect(JSON.stringify(tree.toJSON())).not.toContain('The AI finished the answer')
 expect(JSON.stringify(tree.toJSON())).not.toContain('Shared context')
 expect(JSON.stringify(tree.toJSON())).toContain('This Thread is unavailable or access has expired.')
 expect(tree.root.findAllByType('form')).toHaveLength(0)
 act(()=>tree.unmount())
 vi.useRealTimers()
})

test('does not poll while hidden and aborts an in-flight fetch on unmount',async()=>{
 vi.useFakeTimers()
 const previousVisibility=Object.getOwnPropertyDescriptor(document,'visibilityState')
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'})
 const fetch=vi.fn().mockImplementation(()=>new Promise(()=>{}))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalGuestThread {...props}/>);await vi.advanceTimersByTimeAsync(10000)})
 expect(fetch).not.toHaveBeenCalled()
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
 await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));await Promise.resolve()})
 expect(fetch).toHaveBeenCalledTimes(1)
 const signal=fetch.mock.calls[0][1].signal as AbortSignal
 act(()=>tree.unmount())
 expect(signal.aborted).toBe(true)
 if(previousVisibility)Object.defineProperty(document,'visibilityState',previousVisibility)
 else delete (document as any).visibilityState
 vi.useRealTimers()
})
