import React,{useEffect,useState} from 'react'
import type {HarnessApi} from '../utils/harness'
import {MessageAppCard} from './MessageAppCards'
import {Icon} from './Icon'

type Page={apps:Array<{id:string;name:string}>;files:Array<{id:string;name:string;url:string;messageId:string}>;nextCursor:string|null}
export function ThreadReferences({api,sessionToken,channel,threadId,onClose,onOpen}:{api:HarnessApi;sessionToken:string;channel:string;threadId:string;onClose:()=>void;onOpen:(id:string)=>void}){
 const [attempt,setAttempt]=useState(0),[data,setData]=useState<Page>({apps:[],files:[],nextCursor:null}),[busy,setBusy]=useState(true),[error,setError]=useState(false)
 useEffect(()=>{
  const controller=new AbortController()
  let live=true
  setData({apps:[],files:[],nextCursor:null});setBusy(true);setError(false)
  void (async()=>{
   let cursor:string|null=null
   const apps=new Map<string,Page['apps'][number]>(),files=new Map<string,Page['files'][number]>()
   do{
    const query=new URLSearchParams({orgId:api.orgId,channel,messageId:threadId})
    if(cursor)query.set('after',cursor)
    const timeout=setTimeout(()=>controller.abort(),15000)
    let page:Page
    try{
     const response=await fetch(`${api.httpBase}/channels/thread/references?${query}`,{headers:{'x-session-token':sessionToken},signal:controller.signal})
     if(!response.ok)throw new Error('references')
     page=await response.json()
    }finally{clearTimeout(timeout)}
    if(!live)return
    page.apps.forEach(app=>apps.set(app.id,app));page.files.forEach(file=>files.set(file.id,file))
    if(page.nextCursor===cursor&&cursor)throw new Error('cursor')
    cursor=page.nextCursor
    setData({apps:[...apps.values()],files:[...files.values()],nextCursor:cursor})
   }while(cursor)
  })().catch(()=>{if(live)setError(true)}).finally(()=>{if(live)setBusy(false)})
  return()=>{live=false;controller.abort()}
 },[api,sessionToken,channel,threadId,attempt])
 return <aside className="slk-pane hx-thread-references" aria-label="参照">
  <header><h2>参照</h2><button type="button" aria-label="参照を閉じる" onClick={onClose}><Icon name="x" size={18}/></button></header>
  <p>このスレッドで参照されたアプリとファイル</p>
  <div className="hx-thread-references-items">
   {data.apps.map(app=><MessageAppCard key={app.id} id={app.id} api={api} onOpen={onOpen}/>)}
   {data.files.map(file=><a className="hx-thread-reference-file" key={file.id} href={file.url} target="_blank" rel="noopener noreferrer"><Icon name="file" size={20}/><span>{file.name}</span><Icon name="link" size={14}/></a>)}
   {busy&&<p role="status">参照を読み込んでいます…</p>}
   {error&&<p role="alert">参照をすべて取得できませんでした。<button type="button" onClick={()=>setAttempt(n=>n+1)}>再試行</button></p>}
   {!busy&&!error&&!data.apps.length&&!data.files.length&&<p>参照されたアプリやファイルはありません。</p>}
  </div>
 </aside>
}
