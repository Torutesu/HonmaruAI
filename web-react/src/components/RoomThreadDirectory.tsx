import React, {useCallback,useEffect,useRef,useState} from 'react'
import type {ChannelMessage} from '../types/card'
import {Icon} from './Icon'
import {Avatar} from './Avatar'
import {ago} from '../utils/ago'
import {previewText} from '../utils/messageKeys'

const snippet=(text:string)=>previewText(text.replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[`*_~]/g,''))

type Thread = {parent:ChannelMessage;replies:ChannelMessage[];replyCount:number;lastReplyAt:string;unread:boolean}
type Cursor = {before:string;beforeId:string}
type Page = {threads:Thread[];nextCursor:Cursor|null}
type Api = {httpBase:string;orgId:string;sessionToken:string}
export function RoomThreadDirectory({api,channel,name,selected,activeId,children,onOpen}:{api:Api;channel:string;name:string;selected:boolean;activeId?:string;children:React.ReactNode;onOpen:(id:string)=>void}) {
 const [expanded,setExpanded]=useState(selected),[page,setPage]=useState<Page|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false)
 const request=useRef(0),controller=useRef<AbortController|null>(null)
 const load=useCallback(async(cursor?:Cursor)=>{
  const intent=++request.current;controller.current?.abort();const abort=new AbortController();controller.current=abort
  setBusy(true);setError(false)
  try {
   const query=new URLSearchParams({orgId:api.orgId,channel,...cursor})
   const response=await fetch(`${api.httpBase}/channels/room-threads?${query}`,{headers:{'x-session-token':api.sessionToken},signal:abort.signal})
   if(!response.ok)throw new Error('Room unavailable')
   const data=await response.json() as Page
   if(intent!==request.current)return
   setPage(previous=>cursor&&previous?{...data,threads:[...previous.threads,...data.threads.filter(t=>!previous.threads.some(old=>old.parent.id===t.parent.id))]}:data)
  } catch {if(intent===request.current&&!abort.signal.aborted)setError(true)}
  finally {if(intent===request.current)setBusy(false)}
 },[api.httpBase,api.orgId,api.sessionToken,channel])
 useEffect(()=>{setPage(null);if(expanded)void load();return()=>{request.current++;controller.current?.abort()}},[expanded,load])
 useEffect(()=>{
  if(!expanded)return
  let timer:ReturnType<typeof setTimeout>|undefined
  const changed=(event:Event)=>{const message=(event as CustomEvent<ChannelMessage>).detail;if(message?.channel!==channel)return;clearTimeout(timer);timer=setTimeout(()=>void load(),300)}
  const read=()=>{clearTimeout(timer);timer=setTimeout(()=>void load(),300)}
  window.addEventListener('honmaru:channel-message',changed);window.addEventListener('honmaru:reads-changed',read);window.addEventListener('honmaru:resync',read)
  return()=>{clearTimeout(timer);window.removeEventListener('honmaru:channel-message',changed);window.removeEventListener('honmaru:reads-changed',read);window.removeEventListener('honmaru:resync',read)}
 },[expanded,channel,load])
 return <li className="hx-room-directory"><div className="hx-room-heading"><button type="button" className="hx-room-fold" aria-label={`${name}を${expanded?'折りたたむ':'展開'}`} aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}><Icon name={expanded?'chevron-down':'chevron-right'} size={14}/></button><ul>{children}</ul></div>{expanded&&<ul className="hx-room-threads" aria-label={`${name}のスレッド`}>
  {page?.threads.map(item=>{const title=snippet(item.parent.body)||'新しいスレッド',latest=item.replies.at(-1)||item.parent;return <li key={item.parent.id}><button type="button" className={`hx-room-thread${item.unread?' unread':''}`} aria-current={activeId===item.parent.id?'page':undefined} onClick={()=>onOpen(item.parent.id)}><Avatar name={item.parent.authorName||'?'} url={item.parent.authorAvatar} size={22} round/><span className="hx-room-thread-text"><span className="hx-room-thread-top"><strong>{title}</strong><time dateTime={item.lastReplyAt}>{ago(item.lastReplyAt)}</time></span><span className="hx-room-thread-preview">{snippet(latest.body)||`${item.replyCount}件の返信`}</span></span>{item.unread&&<i aria-label="未読"/>}</button></li>})}
  {error?<li className="hx-room-thread-state" role="status">スレッドを取得できませんでした。<button type="button" onClick={()=>void load()}>再試行</button></li>:busy?<li className="hx-room-thread-state" role="status">読み込み中…</li>:page&&!page.threads.length?<li className="hx-room-thread-state">スレッドはありません</li>:null}
  {page?.nextCursor&&!busy&&!error&&<li><button type="button" className="hx-room-thread-more" onClick={()=>void load(page.nextCursor!)}>さらに表示</button></li>}
 </ul>}</li>
}
