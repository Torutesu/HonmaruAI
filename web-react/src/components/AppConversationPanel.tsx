import {MessageAppCards} from './MessageAppCards'
import {renderRich} from './MessageParts'
import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react'
import {useMentionMenu} from './MentionMenu'
import type {Mentionable} from '../utils/mentions'
import type {AppConversation} from '../utils/harness'
import {Icon} from './Icon'
import type {AppMessage, HarnessApi} from '../utils/harness'

export function mergeMessages(previous:AppMessage[], incoming:AppMessage[]) {
 return [...new Map([...previous,...incoming].map(m=>[m.id,m])).values()].sort((a,b)=>a.id-b.id)
}
export function AppConversationPanel({api,appId,tableId,rowId,title,context,onClose}:{api:HarnessApi;appId:string;tableId?:string;rowId?:string;title:string;context?:string;onClose?:()=>void}) {
 const [messages,setMessages]=useState<AppMessage[]>([]),[draft,setDraft]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[sending,setSending]=useState(false),[hasMore,setHasMore]=useState(false),[older,setOlder]=useState(false)
 const box=useRef<HTMLTextAreaElement>(null)
 const [members,setMembers]=useState<Mentionable[]>([]),[source,setSource]=useState<AppConversation['source']>(null),[aiReplies,setAIReplies]=useState<NonNullable<AppConversation['aiReplies']>>([])
 const [sources,setSources]=useState<Array<{id:string;body:string;channel:string}>|null>(null),[linking,setLinking]=useState(false)
 const mentions=useMentionMenu(box,draft,setDraft,[{ref:'__ai',name:'AI',handle:'AI'},{ref:'__channel',name:'全員',handle:'channel',special:'channel',detail:'閲覧できるメンバーに通知'},...members])
 useEffect(()=>{let active=true;setMembers([]);if(api.members)void api.members().then(r=>{if(active)setMembers(r.members)},()=>{});return()=>{active=false}},[api])
 const sourceRead=useRef('')
 useEffect(()=>{const last=source?.messages.at(-1);if(!source||!last||!api.markSourceRead||document.visibilityState!=='visible')return;const key=source.threadId+':'+last.id;if(sourceRead.current===key)return;sourceRead.current=key;void api.markSourceRead(source.channel,source.threadId,last.createdAt).catch(()=>{if(sourceRead.current===key)sourceRead.current=''})},[api,source])
 const chooseSource=async(messageId:string)=>{setLinking(true);try{await api.inheritConversation(appId,messageId);setSources(null);await refresh(epoch.current)}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setLinking(false)}}
 const stickToBottom=useRef(true),scrollAnchor=useRef<{height:number;top:number}|null>(null)
 const historyLoaded=useRef(false),readVersion=useRef(0),epoch=useRef(0),pending=useRef(false),request=useRef<{body:string;id:string}|null>(null),list=useRef<HTMLDivElement>(null)
 useLayoutEffect(()=>{const element=list.current;if(!element)return;if(scrollAnchor.current){element.scrollTop=scrollAnchor.current.top+element.scrollHeight-scrollAnchor.current.height;scrollAnchor.current=null}else if(stickToBottom.current)element.scrollTop=element.scrollHeight},[messages,source])
 const refresh=useCallback(async(generation:number)=>{
  const read=++readVersion.current;
  try {const data=await api.conversation(appId,{tableId,rowId});if(generation!==epoch.current||read!==readVersion.current)return;setMessages(previous=>mergeMessages(previous,data.messages));setSource(data.source||null);setAIReplies(data.aiReplies||[]);if(!historyLoaded.current)setHasMore(data.hasMore);setError('')}
  catch(e){if(generation===epoch.current&&read===readVersion.current){historyLoaded.current=false;setMessages([]);setSource(null);setSources(null);setAIReplies([]);setError(e instanceof Error?e.message:String(e))}}
  finally {if(generation===epoch.current)setLoading(false)}
 },[api,appId,tableId,rowId])
 useEffect(()=>{const generation=++epoch.current;sourceRead.current='';setMessages([]);setSource(null);setSources(null);setAIReplies([]);setDraft('');setError('');setLoading(true);setHasMore(false);setSending(false);setOlder(false);pending.current=false;request.current=null;historyLoaded.current=false;stickToBottom.current=true;scrollAnchor.current=null;void refresh(generation);const interval=setInterval(()=>{if(document.visibilityState==='visible')void refresh(generation)},10000);return()=>{epoch.current++;clearInterval(interval)}},[refresh])
 const send=async(e:React.FormEvent)=>{
  e.preventDefault();const body=draft.trim();if(!body||pending.current)return;const generation=epoch.current;pending.current=true;setSending(true);setError('');
  if(request.current?.body!==body)request.current={body,id:crypto.randomUUID()};
  try {await api.postConversation(appId,{tableId,rowId},body,request.current.id);if(generation!==epoch.current)return;setDraft('');request.current=null;stickToBottom.current=true;await refresh(generation);list.current?.scrollTo({top:list.current.scrollHeight,behavior:'smooth'})}
  catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:String(e))}
  finally{if(generation===epoch.current){pending.current=false;setSending(false)}}
 }
 const loadOlder=async()=>{if(older||!messages.length)return;const generation=epoch.current;setOlder(true);try{const data=await api.conversation(appId,{tableId,rowId},messages[0].id);if(generation===epoch.current){if(list.current)scrollAnchor.current={height:list.current.scrollHeight,top:list.current.scrollTop};stickToBottom.current=false;setMessages(previous=>mergeMessages(previous,data.messages));historyLoaded.current=true;setHasMore(data.hasMore);setError('')}}catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:String(e))}finally{if(generation===epoch.current)setOlder(false)}}
 return <section className="hx-object-chat" aria-label={rowId?'レコードチャット':'アプリチャット'}>
  <header><Icon name="message" size={16}/><strong>{title}</strong><button type="button" className="hx-app-icon-button" aria-label="会話を更新" onClick={()=>void refresh(epoch.current)}><Icon name="refresh" size={14}/></button>{onClose&&<button type="button" className="hx-app-icon-button" aria-label="チャットを閉じる" onClick={onClose}><Icon name="x" size={16}/></button>}</header>
  <div className="hx-object-messages" ref={list} onScroll={e=>{const element=e.currentTarget;stickToBottom.current=element.scrollHeight-element.scrollTop-element.clientHeight<80}} role="log" aria-label="会話のメッセージ" aria-live="polite">
   {hasMore&&<button type="button" className="pill-btn quiet" disabled={older} onClick={()=>void loadOlder()}>{older?'読み込み中…':'以前のメッセージ'}</button>}
   {loading?<p className="hx-chat-empty">読み込み中…</p>:!messages.length&&!source&&!error?<div className="hx-chat-empty"><Icon name="message" size={28}/><strong>{rowId?'このレコードについて話しましょう':'このアプリについて話しましょう'}</strong><span>会話はこの{rowId?'レコード':'アプリ'}に保存されます。</span></div>:null}
   {source&&<><div className="hx-chat-origin"><Icon name="link" size={14}/>作成元スレッド · {source.channel.startsWith('b:')?'#'+source.channel.slice(2):'元の会話'}</div>{source.messages.map(message=><article key={message.id}><div className="hx-chat-avatar" aria-hidden="true">{message.kind==='ai'?<Icon name="sparkle" size={14}/>:(message.authorName||'メンバー').slice(0,1)}</div><div className="hx-chat-message"><div><strong>{message.authorName||(message.kind==='ai'?'AI':'メンバー')}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></div><div className="hx-chat-body">{renderRich(message.body,()=>'slk-mention')}</div><MessageAppCards text={message.body} api={api}/></div></article>)}</>}
   {source&&messages.length>0&&<div className="hx-chat-origin">引き継ぎ前のアプリ会話</div>}
   {messages.map(message=><article key={message.id}><div className="hx-chat-avatar" aria-hidden="true">{message.authorId==='__app_ai'?<Icon name="sparkle" size={14}/>:Array.from(message.authorName)[0]}</div><div className="hx-chat-message"><div><strong>{message.authorName}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></div><div className="hx-chat-body">{renderRich(message.body,()=>'slk-mention')}</div><MessageAppCards text={message.body} api={api}/></div></article>)}
  </div>
  {aiReplies.some(r=>r.status==='running')&&<div className="hx-chat-context" role="status">AIが返信を作成しています…</div>}
  {aiReplies[0]?.status==='failed'&&<div className="hx-chat-error" role="status">{aiReplies[0].error}</div>}
  {!rowId&&!source&&<div className="hx-chat-source"><button type="button" disabled={linking||loading} onClick={()=>{if(sources){setSources(null);return}void api.conversationSources(appId).then(r=>setSources(r.candidates),e=>setError(String(e.message)))}}><Icon name="link" size={14}/>作成元スレッドを引き継ぐ</button>{sources&&<div><p>以後の送信は選択したスレッドへ届きます。元の閲覧権限を維持します。</p>{sources.length?<select aria-label="作成元スレッド" defaultValue="" disabled={linking} onChange={e=>{if(e.target.value)void chooseSource(e.target.value)}}><option value="">スレッドを選択</option>{sources.map(s=><option key={s.id} value={s.id}>{s.channel.startsWith('b:')?'#'+s.channel.slice(2):'元の会話'} · {s.body}</option>)}</select>:<p>アプリに紐づいたルームに選択可能なスレッドがありません。</p>}</div>}</div>}
  {error&&<div className="hx-chat-error" role="alert">{error}<button type="button" onClick={()=>void refresh(epoch.current)}>再読み込み</button></div>}
  {context&&<div className="hx-chat-context">{context}</div>}
  <form className="hx-chat-compose" onSubmit={e=>void send(e)}>{mentions.menu}<textarea ref={box} onSelect={mentions.track} onClick={mentions.track} aria-label="メッセージを入力" placeholder="メッセージを入力… @でメンション" value={draft} maxLength={4000} disabled={sending} rows={3} onChange={e=>{setDraft(e.target.value);mentions.track()}} onKeyUp={mentions.track} onKeyDown={e=>{if(mentions.onKeyDown(e))return;if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit()}}}/><div><button type="button" className="hx-chat-ai" disabled={sending} onClick={()=>{setDraft(d=>d.includes('@AI')?d:`@AI ${d}`);box.current?.focus()}}><Icon name="sparkle" size={14}/>AIに聞く</button><span>⌘ / Ctrl + Enter</span><button type="submit" className="hx-chat-send" aria-label="メッセージを送信" disabled={sending||loading||!draft.trim()}><Icon name="send" size={16}/></button></div></form>
 </section>
}
