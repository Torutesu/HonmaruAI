import React,{useEffect,useRef,useState} from 'react'
import type {ChannelMessage} from '../types/card'
import {Dialog} from './Dialog'
import {Icon} from './Icon'
import {previewText} from '../utils/messageKeys'
type Api={httpBase:string;orgId:string;sessionToken:string}
export function ThreadSearch({api,channel,threadId,onClose,onSelect}:{api:Api;channel:string;threadId:string;onClose:()=>void;onSelect:(message:ChannelMessage)=>void}){
 const [query,setQuery]=useState(''),[messages,setMessages]=useState<ChannelMessage[]>([]),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false),[searched,setSearched]=useState(false)
 const request=useRef<AbortController|null>(null),generation=useRef(0)
 const cancel=()=>{generation.current++;request.current?.abort();request.current=null}
 useEffect(()=>()=>cancel(),[])
 const load=async(before:string|null)=>{
  cancel()
  const text=query.trim();if(!text)return
  const current=generation.current,controller=new AbortController();request.current=controller
  setBusy(true);setError(false);setSearched(true)
  if(!before){setMessages([]);setCursor(null)}
  const timer=setTimeout(()=>controller.abort(),15000)
  try{
   const params=new URLSearchParams({orgId:api.orgId,channel,messageId:threadId,q:text});if(before)params.set('before',before)
   const response=await fetch(`${api.httpBase}/channels/thread/search?${params}`,{headers:{'x-session-token':api.sessionToken},signal:controller.signal})
   if(!response.ok)throw new Error('search')
   const data=await response.json()
   if(current!==generation.current)return
   setMessages(previous=>before?[...new Map([...previous,...data.messages].map((m:ChannelMessage)=>[m.id,m])).values()]:data.messages)
   setCursor(data.nextCursor)
  }catch{if(current===generation.current)setError(true)}
  finally{clearTimeout(timer);if(current===generation.current)setBusy(false)}
 }
 return <Dialog title="スレッド内を検索" lede="このスレッドのメッセージと返信を検索します。" onClose={onClose} className="hx-thread-search">
  <form onSubmit={event=>{event.preventDefault();void load(null)}}><label><Icon name="search" size={18}/><input autoFocus aria-label="スレッド内の検索語" maxLength={200} value={query} onChange={event=>{cancel();setQuery(event.target.value);setMessages([]);setCursor(null);setBusy(false);setSearched(false);setError(false)}} placeholder="検索語を入力"/></label><button type="submit" disabled={busy||!query.trim()}>検索</button></form>
  <div className="hx-thread-search-results">
   {messages.map(message=><button type="button" key={message.id} onClick={()=>onSelect(message)}><span><strong>{message.authorName||(message.kind==='ai'?'AI':'メンバー')}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></span><p>{previewText(message.body).replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')}</p></button>)}
   {busy&&<p role="status">検索しています…</p>}
   {error&&<p role="alert">検索できませんでした。<button type="button" onClick={()=>void load(cursor)}>再試行</button></p>}
   {searched&&!busy&&!error&&!messages.length&&<p role="status">一致するメッセージはありません。</p>}
   {cursor&&!busy&&!error&&<button type="button" onClick={()=>void load(cursor)}>さらに表示</button>}
  </div>
 </Dialog>
}
