import React,{useEffect,useState} from 'react'
import {Markdown} from '../utils/markdown'
import './SharedThread.css'
type Snapshot={version:1;title:string;messages:Array<{author:string;body:string;createdAt:string;kind:string;attachmentCount:number}>}
export function SharedThread({httpBase,token}:{httpBase:string;token:string}){
 const [data,setData]=useState<{snapshot:Snapshot;expiresAt:string}|null>(null),[state,setState]=useState<'loading'|'ready'|'missing'|'error'>('loading'),[attempt,setAttempt]=useState(0)
 useEffect(()=>{
  const robots=document.createElement('meta');robots.name='robots';robots.content='noindex,nofollow,noarchive';document.head.appendChild(robots)
  return()=>robots.remove()
 },[])
 useEffect(()=>{
  let live=true,controller:AbortController|null=null
  setData(null);setState('loading')
  const refresh=async()=>{
   controller?.abort();const current=new AbortController();controller=current
   const timeout=setTimeout(()=>current.abort(),15000)
   try{
    if(!/^[a-f0-9]{64}$/.test(token)){setData(null);setState('missing');return}
    const response=await fetch(`${httpBase}/channels/shared/${token}`,{credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:current.signal})
    if(!live||controller!==current)return
    if(response.status===404){setData(null);setState('missing');return}
    if(!response.ok)throw new Error('share')
    const value=await response.json()
    if(!live||controller!==current)return
    if(value.snapshot?.version!==1||typeof value.snapshot.title!=='string'||!Array.isArray(value.snapshot.messages)||!value.snapshot.messages.every((m:any)=>typeof m.author==='string'&&typeof m.body==='string'&&typeof m.createdAt==='string')||!Number.isFinite(Date.parse(value.expiresAt)))throw new Error('shape')
    if(Date.parse(value.expiresAt)<=Date.now()){setData(null);setState('missing');return}
    setData(value);setState('ready')
   }catch{if(live&&controller===current){setData(null);setState('error')}}
   finally{clearTimeout(timeout)}
  }
  void refresh()
  const visible=()=>{if(document.visibilityState!=='hidden')void refresh()}
  window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible)
  const timer=setInterval(visible,60000)
  return()=>{live=false;controller?.abort();clearInterval(timer);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible)}
 },[httpBase,token,attempt])
 useEffect(()=>{
  if(!data)return
  const timer=setTimeout(()=>{if(Date.parse(data.expiresAt)<=Date.now()){setData(null);setState('missing')}else setAttempt(n=>n+1)},Math.min(2147483647,Math.max(0,Date.parse(data.expiresAt)-Date.now())))
  return()=>clearTimeout(timer)
 },[data])
 return <main className="shared-thread"><header><a href="#/">Honmaru</a><span>共有された会話</span></header>
  {state==='loading'&&<p role="status">会話を読み込んでいます…</p>}
  {state==='missing'&&<section><h1>この共有リンクは利用できません</h1><p>期限切れ、無効化、または共有範囲が変更された可能性があります。</p></section>}
  {state==='error'&&<section role="alert"><h1>会話を読み込めませんでした</h1><button onClick={()=>setAttempt(n=>n+1)}>再試行</button></section>}
  {state==='ready'&&data&&<><h1>{data.snapshot.title}</h1><p className="shared-thread-note">共有時点の会話です。以後のメッセージは含まれません。</p>
   {data.snapshot.messages.map((message,index)=><article key={index} className={message.kind==='assistant'?'assistant':'person'}><div className="shared-thread-author"><strong>{message.author}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></div><Markdown className="shared-thread-message" source={message.body}/>{message.attachmentCount>0&&<small>添付 {message.attachmentCount} 件（このリンクでは公開されません）</small>}</article>)}
   <footer>有効期限：{new Date(data.expiresAt).toLocaleString()}</footer>
  </>}
 </main>
}
