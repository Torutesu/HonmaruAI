import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {ExternalGuestApp} from './ExternalGuestApp'
import {CustomAppFrame} from './CustomApp'
vi.mock('../utils/appearance',()=>({useAppearance:()=>({theme:'dark'})}))
class CatchAppError extends React.Component<{children:React.ReactNode},{error:string}>{
 state={error:''}
 static getDerivedStateFromError(error:Error){return {error:error.message}}
 render(){return this.state.error?<div role="alert">{this.state.error}</div>:this.props.children}
}

const response=(body:unknown,ok=true)=>({ok,json:async()=>body})
const rows=(start:number,count:number)=>Array.from({length:count},(_,index)=>({id:`row-${start+index}`,data:{title:`Row ${start+index}`},createdAt:'2026-11-01',updatedAt:'2026-11-01'}))

test('external App guest can page through all rows without repeating the first page',async()=>{
 const fetcher=vi.fn()
  .mockResolvedValueOnce(response({app:{id:'app',name:'Shared',description:'',icon:null,tableId:'table',permission:'view'}}))
  .mockResolvedValueOnce(response({rows:rows(0,51)}))
  .mockResolvedValueOnce(response({tables:[{id:'table',name:'Records',key:'primary',columns:[{id:'title',name:'Title',type:'text'}]}]}))
  .mockResolvedValueOnce(response({messages:[]}))
  .mockResolvedValueOnce(response({rows:rows(50,3)}))
 vi.stubGlobal('fetch',fetcher)
 let tree!:ReturnType<typeof create>
 try{
  await act(async()=>{tree=create(<ExternalGuestApp httpBase="https://api.test" orgId="org" appId="app" sessionToken="session"/>);await Promise.resolve();await Promise.resolve()})
  expect(tree.root.findAllByType('tr')).toHaveLength(51)
  await act(async()=>{tree.root.findByProps({children:'Load more records'}).props.onClick();await Promise.resolve();await Promise.resolve()})
  expect(fetcher.mock.calls[4][0]).toContain('/tables/table/rows?limit=51&offset=50')
  expect(tree.root.findAllByType('tr')).toHaveLength(54)
  expect(tree.root.findAllByProps({children:'Load more records'})).toHaveLength(0)
 }finally{if(tree)act(()=>tree.unmount());vi.unstubAllGlobals()}
})

test('external App guest renders only the published Custom App in an opaque iframe',async()=>{
 const html='<main><h1>Published App</h1></main>'
 const fetcher=vi.fn()
  .mockResolvedValueOnce(response({app:{id:'app',name:'Shared',description:'',icon:null,tableId:'table',permission:'view',customHtml:html}}))
  .mockResolvedValueOnce(response({rows:rows(0,1)}))
  .mockResolvedValueOnce(response({tables:[{id:'table',name:'Records',key:'primary',columns:[{id:'title',name:'Title',type:'text'}]}]}))
  .mockResolvedValueOnce(response({messages:[]}))
  .mockResolvedValueOnce(response({rows:rows(0,1)}))
 vi.stubGlobal('fetch',fetcher)
 const contentWindow={postMessage:vi.fn()}
 vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 let tree!:ReturnType<typeof create>
 try{
  await act(async()=>{tree=create(<CatchAppError><ExternalGuestApp httpBase="https://api.test" orgId="org" appId="app" sessionToken="session"/></CatchAppError>,{createNodeMock:e=>e.type==='iframe'?{contentWindow}:null});await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setTimeout(resolve,0))})
  expect(tree.root.findAllByProps({role:'alert'})).toHaveLength(0)
  const frame=tree.root.findByType('iframe')
  expect(frame.props.sandbox).toBe('allow-scripts')
  expect(frame.props.referrerPolicy).toBe('no-referrer')
  expect(frame.props.title).toBe('カスタムアプリ')
  expect(tree.root.findByType(CustomAppFrame).props.rows).toHaveLength(1)
  expect(JSON.stringify(tree.toJSON())).toContain('isolated frame')
 }finally{if(tree)act(()=>tree.unmount());vi.unstubAllGlobals()}
})
