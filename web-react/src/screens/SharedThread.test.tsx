import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {SharedThread} from './SharedThread'
const token='a'.repeat(64)
function environment(){
 const events=new Map<string,()=>void>()
 vi.stubGlobal('window',{addEventListener:(name:string,fn:()=>void)=>events.set(name,fn),removeEventListener:vi.fn()})
 vi.stubGlobal('document',{visibilityState:'visible',head:{appendChild:vi.fn()},createElement:()=>({remove:vi.fn()}),addEventListener:vi.fn(),removeEventListener:vi.fn()})
 return events
}
const snapshot={version:1,title:'Shared request',messages:[{author:'Member',body:'<img src="https://example.com/track">',createdAt:'2026-10-20T00:00:00Z',kind:'person',attachmentCount:0}]}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
test('public reads omit credentials and render content as text; revocation clears it',async()=>{
 const events=environment()
 const fetch=vi.fn().mockResolvedValueOnce({ok:true,status:200,json:async()=>({snapshot,expiresAt:'2099-01-01T00:00:00Z'})}).mockResolvedValueOnce({ok:false,status:404})
 vi.stubGlobal('fetch',fetch);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<SharedThread httpBase="https://api.example" token={token}/>)})
 expect(fetch.mock.calls[0][1]).toMatchObject({credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'})
 expect(tree.root.findAllByType('img')).toHaveLength(0)
 expect(tree.root.findAllByType('article')).toHaveLength(1)
 await act(async()=>events.get('focus')!())
 expect(tree.root.findAllByType('article')).toHaveLength(0)
 expect(JSON.stringify(tree.toJSON())).toContain('この共有リンクは利用できません')
 act(()=>tree.unmount())
})
test('invalid links make no request',async()=>{
 environment();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<SharedThread httpBase="https://api.example" token="invalid"/>)})
 expect(fetch).not.toHaveBeenCalled();expect(JSON.stringify(tree.toJSON())).toContain('この共有リンクは利用できません')
 act(()=>tree.unmount())
})
