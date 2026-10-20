import React,{useEffect,useRef,useState} from 'react'
import type {ChannelMessage} from '../types/card'
import {Icon} from './Icon'
import {textMatchRanges} from '../utils/textMatches'
type Api={httpBase:string;orgId:string;sessionToken:string}
export function ThreadSearch({api,channel,threadId,onClose,onSelect}:{api:Api;channel:string;threadId:string;onClose:()=>void;onSelect:(message:ChannelMessage)=>void}){
 const [query,setQuery]=useState(''),[messages,setMessages]=useState<ChannelMessage[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(false),[index,setIndex]=useState(0),[retry,setRetry]=useState(0)
 const host=useRef<HTMLDivElement>(null),select=useRef(onSelect);select.current=onSelect
 useEffect(()=>{
  const controller=new AbortController();let live=true
  setMessages([]);setIndex(0);setError(false);setBusy(!!query.trim())
  if(!query.trim())return
  const timer=setTimeout(()=>{void(async()=>{
   let cursor:string|null=null;const found=new Map<string,ChannelMessage>()
   do{
    const params=new URLSearchParams({orgId:api.orgId,channel,messageId:threadId,q:query.trim()});if(cursor)params.set('before',cursor)
    const timeout=setTimeout(()=>controller.abort(),15000)
    try{
     const response=await fetch(`${api.httpBase}/channels/thread/search?${params}`,{headers:{'x-session-token':api.sessionToken},signal:controller.signal})
     if(!response.ok)throw new Error('search')
     const data=await response.json();if(!live)return
     data.messages.forEach((m:ChannelMessage)=>found.set(m.id,m))
     if(cursor&&cursor===data.nextCursor)throw new Error('cursor')
     cursor=data.nextCursor
    }finally{clearTimeout(timeout)}
   }while(cursor)
   if(live){const result=[...found.values()];setMessages(result);if(result[0])select.current(result[0])}
  })().catch(()=>{if(live)setError(true)}).finally(()=>{if(live)setBusy(false)})},250)
  return()=>{live=false;clearTimeout(timer);controller.abort()}
 },[api.httpBase,api.orgId,api.sessionToken,channel,threadId,query,retry])
 useEffect(()=>{
  if(typeof CSS==='undefined'||typeof window==='undefined')return
  const registry=(CSS as any).highlights,HighlightClass=(window as any).Highlight
  if(!registry||!HighlightClass)return
  const pane=host.current?.closest('.slk-thread-pane');if(!pane)return
  const paint=()=>{
   const ranges:Range[]=[],needle=query.trim()
   if(needle)for(const body of pane.querySelectorAll('.slk-thread-log .slk-text')){
    const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let node:Node|null
    while((node=walker.nextNode())){
     for(const [start,end] of textMatchRanges(node.textContent||'',needle)){const range=document.createRange();range.setStart(node,start);range.setEnd(node,end);ranges.push(range)}
    }
   }
   registry.set('thread-search',new HighlightClass(...ranges))
  }
  paint();const observer=new MutationObserver(paint);observer.observe(pane,{childList:true,subtree:true,characterData:true})
  return()=>{observer.disconnect();registry.delete('thread-search')}
 },[query])
 const move=(delta:number)=>{if(!messages.length)return;const next=(index+delta+messages.length)%messages.length;setIndex(next);select.current(messages[next])}
 return <div ref={host} className="hx-thread-search-bar" role="search" aria-label="スレッド内を検索" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose()}else if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();move(event.shiftKey?-1:1)}}}>
  <Icon name="search" size={16}/><input autoFocus aria-label="スレッド内の検索語" maxLength={200} placeholder="検索" value={query} onChange={event=>setQuery(event.target.value)}/>
  <span role="status">{busy?'検索中':error?'取得失敗':query.trim()?`${messages.length?index+1:0} / ${messages.length}`:''}</span>
  {error&&<button type="button" aria-label="検索を再試行" onClick={()=>setRetry(n=>n+1)}><Icon name="repeat" size={14}/></button>}
  <button type="button" aria-label="前の結果へ" disabled={busy||!messages.length} onClick={()=>move(1)}><Icon name="arrow-up" size={14}/></button>
  <button type="button" aria-label="新しい結果へ" disabled={busy||!messages.length} onClick={()=>move(-1)}><Icon name="arrow-down" size={14}/></button>
  <button type="button" aria-label="検索を閉じる" onClick={onClose}><Icon name="x" size={14}/></button>
 </div>
}
