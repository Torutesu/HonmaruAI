import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {ThreadReferences} from './ThreadReferences'
vi.mock('./MessageAppCards',()=>({MessageAppCard:({id}:any)=><div data-app={id}/>}))
const api:any={httpBase:'https://api.example',orgId:'team:test',sessionToken:'secret'}
const page=(apps:any[],nextCursor:string|null=null)=>({ok:true,json:async()=>({apps,files:[],nextCursor})})
afterEach(()=>vi.unstubAllGlobals())
test('reads past empty pages, deduplicates app references, and sends scoped credentials',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(page([], '20')).mockResolvedValueOnce(page([{id:'a',name:'A'}],'40')).mockResolvedValueOnce(page([{id:'a',name:'A'},{id:'b',name:'B'}]))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ThreadReferences api={api} sessionToken="secret" channel="b:general" threadId="root" onClose={()=>{}} onOpen={()=>{}}/>)})
 expect(fetch).toHaveBeenCalledTimes(3)
 expect(fetch.mock.calls[1][0]).toContain('after=20')
 expect(fetch.mock.calls[0][1].headers['x-session-token']).toBe('secret')
 expect(tree.root.findAllByProps({'data-app':'a'})).toHaveLength(1)
 expect(tree.root.findAllByProps({'data-app':'b'})).toHaveLength(1)
 act(()=>tree.unmount())
})
test('unmount aborts a pending request and prevents continuing pagination',async()=>{
 let resolve!:(value:any)=>void
 const fetch=vi.fn(()=>new Promise(r=>resolve=r));vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<ThreadReferences api={api} sessionToken="secret" channel="b:general" threadId="root" onClose={()=>{}} onOpen={()=>{}}/>)})
 const signal=(fetch.mock.calls as any)[0][1].signal
 act(()=>tree.unmount());expect(signal.aborted).toBe(true)
 await act(async()=>resolve(page([], '20')))
 expect(fetch).toHaveBeenCalledTimes(1)
})
