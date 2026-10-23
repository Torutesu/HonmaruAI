import React,{useEffect,useRef,useState} from 'react'
import type {ChannelMessage} from '../types/card'
import {Icon} from './Icon'
import {textMatchRanges} from '../utils/textMatches'
type Api={httpBase:string;orgId:string;sessionToken:string}
export function ThreadSearch({api,channel,threadId,onClose,onSelect,focusKey=0}:{api:Api;channel:string;threadId?:string;focusKey?:number;onClose:()=>void;onSelect:(message:ChannelMessage,signal:AbortSignal)=>void|Promise<void>}){
 const [query,setQuery]=useState(''),[messages,setMessages]=useState<ChannelMessage[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(false),[index,setIndex]=useState(0),[retry,setRetry]=useState(0)
 const host=useRef<HTMLDivElement>(null),select=useRef(onSelect);select.current=onSelect
 useEffect(()=>{host.current?.querySelector('input')?.focus()},[focusKey])
 const navigation=useRef<AbortController|null>(null),[moving,setMoving]=useState(false)
 const choose=(message:ChannelMessage)=>{
  navigation.current?.abort();const controller=new AbortController();navigation.current=controller;setMoving(true);setError(false)
  void Promise.resolve().then(()=>{controller.signal.throwIfAborted();return select.current(message,controller.signal)})
   .catch(()=>{if(!controller.signal.aborted)setError(true)}).finally(()=>{if(!controller.signal.aborted)setMoving(false)})
 }
 const chooseRef=useRef(choose);chooseRef.current=choose
 useEffect(()=>{setMoving(false);return()=>navigation.current?.abort()},[query,api.httpBase,api.orgId,api.sessionToken,channel,threadId])
 useEffect(()=>{
  const controller=new AbortController();let live=true
  setMessages([]);setIndex(0);setError(false);setBusy(!!query.trim())
  if(!query.trim())return
  const timer=setTimeout(()=>{void(async()=>{
   let cursor:string|null=null;const found=new Map<string,ChannelMessage>()
   do{
    const params=new URLSearchParams({orgId:api.orgId,channel,q:query.trim()});if(threadId)params.set('messageId',threadId);if(cursor)params.set('before',cursor)
    const timeout=setTimeout(()=>controller.abort(),15000)
    try{
     const response=await fetch(`${api.httpBase}/channels/${threadId?'thread':'room'}/search?${params}`,{headers:{'x-session-token':api.sessionToken},signal:controller.signal})
     if(!response.ok)throw new Error('search')
     const data=await response.json();if(!live)return
     data.messages.forEach((m:ChannelMessage)=>found.set(m.id,m))
     if(cursor&&cursor===data.nextCursor)throw new Error('cursor')
     cursor=data.nextCursor
    }finally{clearTimeout(timeout)}
   }while(cursor)
   if(live){const result=[...found.values()];setMessages(result);if(result[0])chooseRef.current(result[0])}
  })().catch(()=>{if(live)setError(true)}).finally(()=>{if(live)setBusy(false)})},250)
  return()=>{live=false;clearTimeout(timer);controller.abort()}
 },[api.httpBase,api.orgId,api.sessionToken,channel,threadId,query,retry])
 useEffect(()=>{
  if(typeof CSS==='undefined'||typeof window==='undefined')return
  const registry=(CSS as any).highlights,HighlightClass=(window as any).Highlight
  if(!registry||!HighlightClass)return
  const pane=host.current?.closest(threadId?'.slk-thread-pane':'.slk-main');if(!pane)return
  const paint=()=>{
   const ranges:Range[]=[],needle=query.trim()
   if(needle)for(const body of pane.querySelectorAll(threadId?'.slk-thread-log .slk-text':'.slk-log .slk-text')){
    const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let node:Node|null
    while((node=walker.nextNode())){
     for(const [start,end] of textMatchRanges(node.textContent||'',needle)){const range=document.createRange();range.setStart(node,start);range.setEnd(node,end);ranges.push(range)}
    }
   }
   registry.set(threadId?'thread-search':'room-search',new HighlightClass(...ranges))
  }
  paint();const observer=new MutationObserver(paint);observer.observe(pane,{childList:true,subtree:true,characterData:true})
  return()=>{observer.disconnect();registry.delete(threadId?'thread-search':'room-search')}
 },[query,threadId])
 const move=(delta:number)=>{if(!messages.length)return;const next=(index+delta+messages.length)%messages.length;setIndex(next);choose(messages[next])}
 return <div ref={host} className="hx-thread-search-bar" role="search" aria-label={threadId?"スレッド内を検索":"ルーム内を検索"} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose()}else if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();move(event.shiftKey?-1:1)}}}>
  <Icon name="search" size={16}/><input autoFocus aria-label={threadId?"スレッド内の検索語":"ルーム内の検索語"} maxLength={200} placeholder="検索" value={query} onChange={event=>setQuery(event.target.value)}/>
  <span role="status">{busy?'検索中':moving?'移動中':error?'取得失敗':query.trim()?`${messages.length?index+1:0} / ${messages.length}`:''}</span>
  {error&&<button type="button" aria-label="検索を再試行" onClick={()=>setRetry(n=>n+1)}><Icon name="repeat" size={14}/></button>}
  <button type="button" aria-label="前の結果へ" disabled={busy||!messages.length} onClick={()=>move(1)}><Icon name="arrow-up" size={14}/></button>
  <button type="button" aria-label="新しい結果へ" disabled={busy||!messages.length} onClick={()=>move(-1)}><Icon name="arrow-down" size={14}/></button>
  <button type="button" aria-label="検索を閉じる" onClick={onClose}><Icon name="x" size={14}/></button>
 </div>
}
