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
 let onVisibility:(()=>void)|undefined
 const doc={visibilityState:'hidden',addEventListener:vi.fn((_name:string,listener:()=>void)=>{onVisibility=listener}),removeEventListener:vi.fn()}
 vi.stubGlobal('document',doc)
 const fetch=vi.fn().mockImplementation(()=>new Promise(()=>{}))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalGuestThread {...props}/>);await vi.advanceTimersByTimeAsync(10000)})
 expect(fetch).not.toHaveBeenCalled()
 doc.visibilityState='visible'
 await act(async()=>{onVisibility?.();await Promise.resolve()})
 expect(fetch).toHaveBeenCalledTimes(1)
 const signal=fetch.mock.calls[0][1].signal as AbortSignal
 act(()=>tree.unmount())
 expect(signal.aborted).toBe(true)
 expect(doc.removeEventListener).toHaveBeenCalled()
 vi.useRealTimers()
})

test('edit guests upload an attachment, attach it to a reply, and react to the shared Thread',async()=>{
 const uploaded={id:'upload-1',name:'plan & scope.txt',type:'text/plain',size:4}
 const reply={id:'reply-file',body:'See the attached plan',authorName:'Guest',mine:true,createdAt:'2026-11-06T00:01:00Z',parentId:'root',files:[{...uploaded,url:'/external/threads/org%2Fone/root%20one/files/f_0123456789abcdef01234567'}]}
 const refreshed={...thread('edit'),thread:{...thread('edit').thread,replies:[reply]}}
 const fetch=vi.fn()
   .mockResolvedValueOnce(ok(thread('edit')))
   .mockResolvedValueOnce(ok({file:uploaded},201))
   .mockResolvedValueOnce(ok({sent:true,messageId:'reply-file'},201))
   .mockResolvedValueOnce(ok(refreshed))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalGuestThread {...props}/>);await Promise.resolve();await Promise.resolve()})
 const selected={name:'plan & scope.txt',type:'text/plain',size:4} as File
 await act(async()=>{
   tree.root.findByProps({id:'external-thread-files'}).props.onChange({target:{files:[selected],value:'selected'}})
   await Promise.resolve();await Promise.resolve()
 })
 expect(fetch.mock.calls[1][0]).toBe('https://api.example/external/threads/org%2Fone/root%20one/files?name=plan%20%26%20scope.txt')
 expect(fetch.mock.calls[1][1]).toMatchObject({method:'POST',headers:{'x-session-token':'session','content-type':'text/plain'}})
 expect(fetch.mock.calls[1][1].body).toBe(selected)
 expect(JSON.stringify(tree.toJSON())).toContain('plan & scope.txt')
 act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'See the attached plan'}}))
 await act(async()=>{tree.root.findByType('form').props.onSubmit({preventDefault(){}});await Promise.resolve();await Promise.resolve();await Promise.resolve()})
 expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({body:'See the attached plan',files:['upload-1']})
 expect(JSON.stringify(tree.toJSON())).toContain('See the attached plan')
 act(()=>tree.unmount())
})

test('external guests can search Unicode reactions without seeing cached workspace emoji names or assets',async()=>{
 const customUrl='https://api.example/private-workspace-emoji.png'
 const doc={visibilityState:'visible',addEventListener:vi.fn(),removeEventListener:vi.fn(),activeElement:null}
 vi.stubGlobal('document',doc)
 vi.stubGlobal('window',{matchMedia:()=>({matches:true}),addEventListener:vi.fn(),removeEventListener:vi.fn()})
 vi.stubGlobal('HTMLElement',class {})
 const fetch=vi.fn()
   .mockResolvedValueOnce(ok({emoji:[{name:'private_mark',url:customUrl,by:'owner',createdAt:'2026-11-06T00:00:00Z'}]}))
   .mockResolvedValueOnce(ok(thread('edit')))
   .mockResolvedValueOnce(ok({messageId:'root',reactions:[{emoji:'🚀',count:1,mine:true}]}))
 vi.stubGlobal('fetch',fetch)
 const {loadCustomEmoji}=await import('../utils/customEmoji')
 const {loadEmojiData,rememberEmoji}=await import('../utils/emojiSearch')
 await loadCustomEmoji(props.httpBase,props.sessionToken,props.orgId)
 rememberEmoji(':private_mark:')
 await loadEmojiData()
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalGuestThread {...props}/>);await Promise.resolve();await Promise.resolve()})
 const add=tree.root.findAllByProps({'aria-label':'Add reaction'})[0]
 act(()=>add.props.onClick())
 expect(tree.root.findAllByProps({role:'dialog'})).toHaveLength(1)
 expect(JSON.stringify(tree.toJSON())).not.toContain(':private_mark:')
 expect(JSON.stringify(tree.toJSON())).not.toContain(customUrl)
 const search=tree.root.findByProps({'data-emoji-search':true})
 await act(async()=>{search.props.onChange({target:{value:'rocket'}});await Promise.resolve();await Promise.resolve()})
 const rocket=tree.root.findAllByType('button').find(button=>button.props['aria-label']==='🚀')
 expect(rocket).toBeTruthy()
 await act(async()=>{rocket!.props.onClick();await Promise.resolve();await Promise.resolve()})
 expect(fetch.mock.calls[2][0]).toBe('https://api.example/external/threads/org%2Fone/root%20one/reactions')
 expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({messageId:'root',emoji:'🚀'})
 expect(JSON.stringify(tree.toJSON())).not.toContain(':private_mark:')
 expect(JSON.stringify(tree.toJSON())).not.toContain(customUrl)
 act(()=>tree.unmount())
})
