import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {ThreadShare} from './ThreadShare'
vi.mock('./Dialog',()=>({Dialog:({children}:any)=><section>{children}</section>}))
const api={httpBase:'https://api.example',orgId:'team:test',sessionToken:'token'}
const preview={snapshot:{title:'Review',messages:[{author:'Member',body:'Text',attachmentCount:1}]},digest:'a'.repeat(64),blocked:false,dlp:[]}
afterEach(()=>vi.unstubAllGlobals())
test('opening only reads; publication requires confirmation and uses the reviewed digest',async()=>{
 vi.stubGlobal('location',{origin:'https://app.example',pathname:'/',search:'?code=private'})
 const fetch=vi.fn(async(url:string,options:any)=>{
  const value=options.method==='POST'?{id:'share',token:'b'.repeat(64),expiresAt:'2099-01-01'}:url.includes('share-preview')?preview:url.includes('thread-sharing')?{policy:{enabled:true,version:1},canManage:false}:{shares:[]}
  return {ok:true,json:async()=>value}
 });vi.stubGlobal('fetch',fetch);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ThreadShare api={api} channel="b:general" threadId="root" onClose={()=>{}}/>)})
 expect(fetch.mock.calls.every(call=>call[1].method==='GET')).toBe(true)
 const publish=()=>tree.root.findAllByType('button').find(b=>b.children.includes('公開リンクを作成'))!
 expect(publish().props.disabled).toBe(true)
 act(()=>tree.root.findByType('input').props.onChange({target:{checked:true}}))
 await act(async()=>publish().props.onClick())
 const write=fetch.mock.calls.find(call=>call[1].method==='POST')!
 expect(JSON.parse(write[1].body)).toMatchObject({confirmPublic:true,digest:preview.digest,messageId:'root'})
 expect(tree.root.findByProps({'aria-label':'公開リンク'}).props.value).toBe(`https://app.example/#/shared/${'b'.repeat(64)}`)
 act(()=>tree.unmount())
})
test('DLP blocking never exposes a publish button',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>url.includes('share-preview')?{...preview,blocked:true,dlp:[{id:'rule',name:'Restricted',action:'block'}]}:url.includes('thread-sharing')?{policy:{enabled:true,version:1},canManage:false}:{shares:[]}})))
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ThreadShare api={api} channel="b:general" threadId="root" onClose={()=>{}}/>)})
 expect(tree.root.findAllByType('button').some(b=>b.children.includes('公開リンクを作成'))).toBe(false)
 act(()=>tree.unmount())
})
