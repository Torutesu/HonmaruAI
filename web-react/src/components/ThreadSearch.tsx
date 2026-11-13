import React,{useEffect,useRef,useState} from 'react'
import type {ChannelMessage} from '../types/card'
import {Icon} from './Icon'
import {textMatchRanges} from '../utils/textMatches'
import {enterKey} from '../utils/keys'
import {hashForApp} from '../utils/route'
import {openFileConversation} from '../utils/fileConversation'
type Api={httpBase:string;orgId:string;sessionToken:string}
type FileHit={id:string;name:string;scope:string;snippet:string}
type RecordHit={id:string;appId:string;appName:string;tableId:string;tableName:string;rowId:string;snippet:string}
export function ThreadSearch({api,channel,threadId,onClose,onSelect,focusKey=0}:{api:Api;channel:string;threadId?:string;focusKey?:number;onClose:()=>void;onSelect:(message:ChannelMessage,signal:AbortSignal)=>void|Promise<void>}){
 const [query,setQuery]=useState(''),[messages,setMessages]=useState<ChannelMessage[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(false),[index,setIndex]=useState(0),[retry,setRetry]=useState(0)
 const [files,setFiles]=useState<FileHit[]>([]),[records,setRecords]=useState<RecordHit[]>([]),[fileCursor,setFileCursor]=useState<string|null>(null),[recordCursor,setRecordCursor]=useState<string|null>(null),[filesTruncated,setFilesTruncated]=useState(false),[recordsTruncated,setRecordsTruncated]=useState(false),[loadingMore,setLoadingMore]=useState({files:false,records:false}),[resourcePageError,setResourcePageError]=useState({files:false,records:false}),[openingResource,setOpeningResource]=useState<string|null>(null)
 const pageControllers=useRef<Partial<Record<'files'|'records',AbortController>>>({})
 const host=useRef<HTMLDivElement>(null),select=useRef(onSelect);select.current=onSelect
 useEffect(()=>{host.current?.querySelector('input')?.focus()},[focusKey])
 const navigation=useRef<AbortController|null>(null),[moving,setMoving]=useState(false)
 const choose=(message:ChannelMessage)=>{
  navigation.current?.abort();const controller=new AbortController();navigation.current=controller;setMoving(true);setError(false)
  void Promise.resolve().then(()=>{controller.signal.throwIfAborted();return select.current(message,controller.signal)})
   .catch(()=>{if(!controller.signal.aborted)setError(true)}).finally(()=>{if(!controller.signal.aborted)setMoving(false)})
 }
 const chooseRef=useRef(choose);chooseRef.current=choose
 const openFile=async(file:FileHit)=>{
  if(openingResource)return
  setOpeningResource(file.id);setError(false)
  try{location.hash=await openFileConversation(file.id)}catch{setError(true)}finally{setOpeningResource(null)}
 }
 const openRecord=(record:RecordHit)=>{location.hash=hashForApp(record.appId,api.orgId,{tableId:record.tableId,rowId:record.rowId},'data')}
 const loadMoreResources=async(kind:'files'|'records')=>{
  const cursor=kind==='files'?fileCursor:recordCursor
  if(!cursor||threadId||loadingMore[kind]||pageControllers.current[kind])return
  const controller=new AbortController();pageControllers.current[kind]=controller
  setLoadingMore(state=>({...state,[kind]:true}));setResourcePageError(state=>({...state,[kind]:false}))
  const params=new URLSearchParams({orgId:api.orgId,channel,q:query.trim(),resources:'1'})
  params.set(kind==='files'?'fileCursor':'recordCursor',cursor)
  params.set(kind==='files'?'skipRecords':'skipFiles','1')
  const timeout=setTimeout(()=>controller.abort(),15000)
  try{
   const response=await fetch(`${api.httpBase}/channels/room/search?${params}`,{headers:{'x-session-token':api.sessionToken},signal:controller.signal})
   if(!response.ok)throw new Error('search')
   const data=await response.json()
   if(controller.signal.aborted)return
   if(kind==='files'){
    const page:Array<FileHit>=Array.isArray(data.files)?data.files:[]
    setFiles(previous=>{const ids=new Set(previous.map(item=>item.id));return [...previous,...page.filter(item=>!ids.has(item.id))]})
    setFileCursor(typeof data.filesNextCursor==='string'?data.filesNextCursor:null);setFilesTruncated(Boolean(data.filesTruncated))
   }else{
    const page:Array<RecordHit>=Array.isArray(data.records)?data.records:[]
    setRecords(previous=>{const ids=new Set(previous.map(item=>`${item.appId}:${item.rowId}`));return [...previous,...page.filter(item=>!ids.has(`${item.appId}:${item.rowId}`))]})
    setRecordCursor(typeof data.recordsNextCursor==='string'?data.recordsNextCursor:null);setRecordsTruncated(Boolean(data.recordsTruncated))
   }
  }catch{if(pageControllers.current[kind]===controller)setResourcePageError(state=>({...state,[kind]:true}))}
  finally{clearTimeout(timeout);if(pageControllers.current[kind]===controller){setLoadingMore(state=>({...state,[kind]:false}));delete pageControllers.current[kind]}}
 }
 useEffect(()=>{setMoving(false);return()=>navigation.current?.abort()},[query,api.httpBase,api.orgId,api.sessionToken,channel,threadId])
 useEffect(()=>{
  const controller=new AbortController();let live=true
  for(const pending of Object.values(pageControllers.current))pending?.abort();pageControllers.current={}
  setMessages([]);setFiles([]);setRecords([]);setFileCursor(null);setRecordCursor(null);setFilesTruncated(false);setRecordsTruncated(false);setLoadingMore({files:false,records:false});setResourcePageError({files:false,records:false});setIndex(0);setError(false);setBusy(!!query.trim())
  if(!query.trim())return
  const timer=setTimeout(()=>{void(async()=>{
   let cursor:string|null=null;const found=new Map<string,ChannelMessage>()
   do{
     const params=new URLSearchParams({orgId:api.orgId,channel,q:query.trim()});if(threadId)params.set('messageId',threadId);if(cursor)params.set('before',cursor);else if(!threadId)params.set('resources','1')
    const timeout=setTimeout(()=>controller.abort(),15000)
    try{
     const response=await fetch(`${api.httpBase}/channels/${threadId?'thread':'room'}/search?${params}`,{headers:{'x-session-token':api.sessionToken},signal:controller.signal})
     if(!response.ok)throw new Error('search')
     const data=await response.json();if(!live)return
     data.messages.forEach((m:ChannelMessage)=>found.set(m.id,m))
     if(!cursor){setFiles(Array.isArray(data.files)?data.files:[]);setRecords(Array.isArray(data.records)?data.records:[]);setFileCursor(typeof data.filesNextCursor==='string'?data.filesNextCursor:null);setRecordCursor(typeof data.recordsNextCursor==='string'?data.recordsNextCursor:null);setFilesTruncated(Boolean(data.filesTruncated));setRecordsTruncated(Boolean(data.recordsTruncated))}
     if(cursor&&cursor===data.nextCursor)throw new Error('cursor')
     cursor=data.nextCursor
    }finally{clearTimeout(timeout)}
   }while(cursor)
   if(live){const result=[...found.values()];setMessages(result);if(result[0])chooseRef.current(result[0])}
  })().catch(()=>{if(live)setError(true)}).finally(()=>{if(live)setBusy(false)})},250)
  return()=>{live=false;clearTimeout(timer);controller.abort();for(const pending of Object.values(pageControllers.current))pending?.abort();pageControllers.current={}}
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
 return <div ref={host} className="hx-thread-search-bar" role="search" aria-label={threadId?"スレッド内を検索":"ルーム内を検索"} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose()}else if(event.target===host.current?.querySelector('input')&&enterKey(event)){event.preventDefault();move(event.shiftKey?-1:1)}}}>
  <Icon name="search" size={16}/><input autoFocus aria-label={threadId?"スレッド内の検索語":"ルーム内の検索語"} maxLength={200} placeholder="検索" value={query} onChange={event=>setQuery(event.target.value)}/>
  <span role="status">{busy?'検索中':moving?'移動中':error?'取得失敗':query.trim()?`${messages.length?index+1:0} / ${messages.length}`:''}</span>
  {error&&<button type="button" aria-label="検索を再試行" onClick={()=>setRetry(n=>n+1)}><Icon name="repeat" size={14}/></button>}
  <button type="button" aria-label="前の結果へ" disabled={busy||!messages.length} onClick={()=>move(1)}><Icon name="arrow-up" size={14}/></button>
  <button type="button" aria-label="新しい結果へ" disabled={busy||!messages.length} onClick={()=>move(-1)}><Icon name="arrow-down" size={14}/></button>
  <button type="button" aria-label="検索を閉じる" onClick={onClose}><Icon name="x" size={14}/></button>
  {(files.length>0||records.length>0||filesTruncated||recordsTruncated)&&<div className="hx-thread-search-resources" role="region" aria-label="このルームのリソース">
   {(files.length>0||filesTruncated)&&<section className="hx-thread-search-resource-section" aria-label="ファイルの検索結果">
    <h3>このルームのファイル</h3>
    {files.map(file=><button key={file.id} type="button" className="hx-thread-search-resource" aria-label={`ファイルを開く: ${file.name}`} disabled={openingResource!==null} onClick={()=>void openFile(file)}>
     <strong>{file.name}</strong><span>{file.snippet}</span>
    </button>)}
    {filesTruncated&&<div className="hx-thread-search-more-row">{resourcePageError.files&&<span role="status">追加のファイルを取得できませんでした。</span>}<button type="button" className="hx-thread-search-more" disabled={loadingMore.files||!fileCursor} onClick={()=>void loadMoreResources('files')}>{loadingMore.files?'読み込み中…':resourcePageError.files?'再試行':'さらに表示'}</button></div>}
   </section>}
   {(records.length>0||recordsTruncated)&&<section className="hx-thread-search-resource-section" aria-label="Appレコードの検索結果">
    <h3>このルームにリンクされたApp</h3>
    {records.map(record=><button key={`${record.appId}:${record.rowId}`} type="button" className="hx-thread-search-resource" aria-label={`レコードを開く: ${record.appName} · ${record.tableName}`} onClick={()=>openRecord(record)}>
     <strong>{record.appName} · {record.tableName}</strong><span>{record.snippet}</span>
    </button>)}
    {recordsTruncated&&<div className="hx-thread-search-more-row">{resourcePageError.records&&<span role="status">追加のレコードを取得できませんでした。</span>}<button type="button" className="hx-thread-search-more" disabled={loadingMore.records||!recordCursor} onClick={()=>void loadMoreResources('records')}>{loadingMore.records?'読み込み中…':resourcePageError.records?'再試行':'さらに表示'}</button></div>}
   </section>}
  </div>}
 </div>
}
