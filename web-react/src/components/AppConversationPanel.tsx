import {hashForAppSource} from '../utils/route'
import {resolveDraftSuggestion} from '../utils/draftSuggestion'
import {DraftSuggestion} from './DraftSuggestion'
import {MessageAppCards} from './MessageAppCards'
import {renderRich} from './MessageParts'
import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react'
import {useMentionMenu} from './MentionMenu'
import type {Mentionable} from '../utils/mentions'
import type {AppAnnotation, AppAnnotationMeta, AppConversation} from '../utils/harness'
import {Icon} from './Icon'
import type {AppMessage, HarnessApi} from '../utils/harness'
import {enterKey, formatCombo, isMacPlatform} from '../utils/keys'
import {useT} from '../utils/i18n'
import {getLocale} from '../utils/locale'

export function mergeMessages(previous:AppMessage[], incoming:AppMessage[]) {
 return [...new Map([...previous,...incoming].map(m=>[m.id,m])).values()].sort((a,b)=>a.id-b.id)
}
export function AppConversationPanel({api,appId,tableId,rowId,title,context,onClose,initialDraft,onInitialDraftConsumed,annotationDraft,onAnnotationDraftConsumed,onAnnotationsChange}:{api:HarnessApi;appId:string;tableId?:string;rowId?:string;title:string;context?:string;initialDraft?:string;onInitialDraftConsumed?:()=>void;annotationDraft?:{id:string;text:string;marker:AppAnnotationMeta}|null;onAnnotationDraftConsumed?:(id:string)=>void;onAnnotationsChange?:(annotations:AppAnnotation[])=>void;onClose?:()=>void}) {
 const t=useT()
 const [messages,setMessages]=useState<AppMessage[]>([]),[draft,setDraft]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[sending,setSending]=useState(false),[hasMore,setHasMore]=useState(false),[older,setOlder]=useState(false)
 const [suggestedDraft,setSuggestedDraft]=useState('')
 const [annotationMeta,setAnnotationMeta]=useState<AppAnnotationMeta|null>(null)
 const saveDraft:React.Dispatch<React.SetStateAction<string>>=value=>setDraft(previous=>{const next=typeof value==='function'?value(previous):value;api.drafts?.write(next,appId,tableId,rowId);return next})
 const annotationsChanged=useRef(onAnnotationsChange);annotationsChanged.current=onAnnotationsChange
 const consumedAnnotation=useRef<string|null>(null)
 const box=useRef<HTMLTextAreaElement>(null)
 const [members,setMembers]=useState<Mentionable[]>([]),[source,setSource]=useState<AppConversation['source']>(null),[aiReplies,setAIReplies]=useState<NonNullable<AppConversation['aiReplies']>>([]),[proposals,setProposals]=useState<NonNullable<AppConversation['proposals']>>([]),[canEditRecord,setCanEditRecord]=useState(false),[reviewing,setReviewing]=useState('')
 const [sources,setSources]=useState<Array<{id:string;body:string;channel:string}>|null>(null),[linking,setLinking]=useState(false)
 const mentions=useMentionMenu(box,draft,saveDraft,[{ref:'__ai',name:'AI',handle:'AI'},{ref:'__channel',name:t('Everyone'),handle:'channel',special:'channel',detail:t('Notify members who can access this app.')},...members])
 useEffect(()=>{let active=true;setMembers([]);if(api.members)void api.members().then(r=>{if(active)setMembers(r.members)},()=>{});return()=>{active=false}},[api])
 const sourceRead=useRef('')
 useEffect(()=>{const last=source?.messages.at(-1);if(!source||!last||!api.markSourceRead||document.visibilityState!=='visible')return;const key=source.threadId+':'+last.id;if(sourceRead.current===key)return;sourceRead.current=key;void api.markSourceRead(source.channel,source.threadId,last.createdAt).catch(()=>{if(sourceRead.current===key)sourceRead.current=''})},[api,source])
 const chooseSource=async(messageId:string)=>{const generation=epoch.current;setLinking(true);try{await api.inheritConversation(appId,messageId);if(generation!==epoch.current)return;setSources(null);await refresh(generation)}catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:String(e))}finally{if(generation===epoch.current)setLinking(false)}}
 const findSources=async()=>{if(sources){setSources(null);return}const generation=epoch.current;try{const result=await api.conversationSources(appId);if(generation===epoch.current)setSources(result.candidates)}catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:String(e))}}
 const stickToBottom=useRef(true),scrollAnchor=useRef<{height:number;top:number}|null>(null)
 const historyLoaded=useRef(false),readVersion=useRef(0),epoch=useRef(0),pending=useRef(false),request=useRef<{body:string;id:string}|null>(null),list=useRef<HTMLDivElement>(null)
 useLayoutEffect(()=>{const element=list.current;if(!element)return;if(scrollAnchor.current){element.scrollTop=scrollAnchor.current.top+element.scrollHeight-scrollAnchor.current.height;scrollAnchor.current=null}else if(stickToBottom.current)element.scrollTop=element.scrollHeight},[messages,source])
 const refresh=useCallback(async(generation:number)=>{
  const read=++readVersion.current;
  try {const data=await api.conversation(appId,{tableId,rowId});if(generation!==epoch.current||read!==readVersion.current)return;setMessages(previous=>mergeMessages(previous,data.messages));setSource(data.source||null);setAIReplies(data.aiReplies||[]);setProposals(data.proposals||[]);setCanEditRecord(Boolean(data.canEditRecord));annotationsChanged.current?.(data.annotations||[]);if(!historyLoaded.current)setHasMore(data.hasMore);setError('')}
  catch(e){if(generation===epoch.current&&read===readVersion.current){historyLoaded.current=false;setMessages([]);setSource(null);setSources(null);setAIReplies([]);setProposals([]);setCanEditRecord(false);annotationsChanged.current?.([]);setError(e instanceof Error?e.message:String(e))}}
  finally {if(generation===epoch.current)setLoading(false)}
 },[api,appId,tableId,rowId])
 const reviewProposal=async(id:string,action:'approve'|'reject'|'undo')=>{if(!api.reviewRecordProposal)return;const generation=epoch.current;setReviewing(id);setError('');try{await api.reviewRecordProposal(appId,id,action);if(generation===epoch.current)await refresh(generation)}catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:String(e))}finally{if(generation===epoch.current)setReviewing('')}}
 useEffect(()=>{
  const generation=++epoch.current
  sourceRead.current='';setMessages([]);setSource(null);setSources(null);setLinking(false);setAIReplies([]);setProposals([]);setCanEditRecord(false)
  const savedDraft=api.drafts?.read(appId,tableId,rowId)||''
  // A route suggestion must not replace the user's existing unsent text.
  // Keep it visible as a separate choice, and leave the route intact until
  // they append or dismiss it so a refresh cannot lose the suggestion.
  const resolvedDraft=resolveDraftSuggestion(savedDraft,'',initialDraft||'')
  const restoredDraft=resolvedDraft.draft
  const suggestion=resolvedDraft.suggestion
  setDraft(restoredDraft);setSuggestedDraft(suggestion)
  const restoredAnnotation=!restoredDraft?null:api.drafts?.readAnnotation?.(appId,tableId,rowId)||null
  setAnnotationMeta(restoredAnnotation)
  if(restoredDraft)api.drafts?.write(restoredDraft,appId,tableId,rowId)
  if(initialDraft&&!suggestion)onInitialDraftConsumed?.()
  setError('');setLoading(true);setHasMore(false);setSending(false);setOlder(false);pending.current=false;request.current=null;historyLoaded.current=false;stickToBottom.current=true;scrollAnchor.current=null
  void refresh(generation)
  const onAppActivity=(event:Event)=>{if((event as CustomEvent<{appId?:string}>).detail?.appId===appId)void refresh(generation)}
  const activityWindow=typeof window==='undefined'?null:window
  activityWindow?.addEventListener('honmaru:app-activity-changed',onAppActivity)
  const interval=setInterval(()=>{if(document.visibilityState==='visible')void refresh(generation)},10000)
  return()=>{epoch.current++;clearInterval(interval);activityWindow?.removeEventListener('honmaru:app-activity-changed',onAppActivity)}
  // This hydrates once for the keyed app/record conversation. Later route
  // changes must not reset text a person has already started editing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[refresh])
 useEffect(()=>{if(!annotationDraft||consumedAnnotation.current===annotationDraft.id)return;consumedAnnotation.current=annotationDraft.id;saveDraft(previous=>[previous.trim(),annotationDraft.text].filter(Boolean).join('\n\n'));setAnnotationMeta(annotationDraft.marker);api.drafts?.writeAnnotation?.(annotationDraft.marker,appId,tableId,rowId);onAnnotationDraftConsumed?.(annotationDraft.id)},[annotationDraft?.id])
 useEffect(()=>{if(!draft.trim()&&annotationMeta){setAnnotationMeta(null);api.drafts?.writeAnnotation?.(null,appId,tableId,rowId)}},[draft,annotationMeta,api,appId,tableId,rowId])
 const send=async(e:React.FormEvent)=>{
  e.preventDefault();const body=draft.trim();if(!body||pending.current)return;const generation=epoch.current;pending.current=true;setSending(true);setError('');
  if(request.current?.body!==body)request.current={body,id:crypto.randomUUID()};
  try {await api.postConversation(appId,{tableId,rowId},body,request.current.id,annotationMeta||undefined);if(generation!==epoch.current)return;saveDraft('');setAnnotationMeta(null);api.drafts?.writeAnnotation?.(null,appId,tableId,rowId);request.current=null;stickToBottom.current=true;await refresh(generation);list.current?.scrollTo({top:list.current.scrollHeight,behavior:'smooth'})}
  catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:String(e))}
  finally{if(generation===epoch.current){pending.current=false;setSending(false)}}
 }
 const appendSuggestedDraft=()=>{
  if(!suggestedDraft)return
  saveDraft(previous=>[previous,suggestedDraft].filter(value=>value.trim()).join('\n\n'))
  setSuggestedDraft('')
  onInitialDraftConsumed?.()
 }
 const dismissSuggestedDraft=()=>{
  if(!suggestedDraft)return
  setSuggestedDraft('')
  onInitialDraftConsumed?.()
 }
 const loadOlder=async()=>{if(older||!messages.length)return;const generation=epoch.current;setOlder(true);try{const data=await api.conversation(appId,{tableId,rowId},messages[0].id);if(generation===epoch.current){if(list.current)scrollAnchor.current={height:list.current.scrollHeight,top:list.current.scrollTop};stickToBottom.current=false;setMessages(previous=>mergeMessages(previous,data.messages));historyLoaded.current=true;setHasMore(data.hasMore);setError('')}}catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:String(e))}finally{if(generation===epoch.current)setOlder(false)}}
 return <section className="hx-object-chat" aria-label={rowId?t('Record conversation'):t('App conversation')}>
  <header><Icon name="message" size={16}/><strong>{title}</strong><button type="button" className="hx-app-icon-button" aria-label={t('Refresh conversation')} onClick={()=>void refresh(epoch.current)}><Icon name="refresh" size={14}/></button>{onClose&&<button type="button" className="hx-app-icon-button" aria-label={t('Close chat')} onClick={onClose}><Icon name="x" size={16}/></button>}</header>
  <div className="hx-object-messages" ref={list} onScroll={e=>{const element=e.currentTarget;stickToBottom.current=element.scrollHeight-element.scrollTop-element.clientHeight<80}} role="log" aria-label={t('Conversation messages')} aria-live="polite">
   {hasMore&&<button type="button" className="pill-btn quiet" disabled={older} onClick={()=>void loadOlder()}>{older?t('Loading…'):t('Earlier messages')}</button>}
   {loading?<p className="hx-chat-empty">{t('Loading…')}</p>:!messages.length&&!source&&!error?<div className="hx-chat-empty"><Icon name="message" size={28}/><strong>{rowId?t('Start a conversation about this record'):t('Start a conversation about this app')}</strong><span>{rowId?t('Conversation is saved with this record.'):t('Conversation is saved with this app.')}</span></div>:null}
   {source&&<><a className="hx-chat-origin" href={hashForAppSource(appId,api.orgId)} aria-label={t('Open source thread')}><Icon name="link" size={14}/>{t('Source thread')} · {source.channel.startsWith('b:')?'#'+source.channel.slice(2):t('Original conversation')}</a>{source.messages.map(message=><article key={message.id}><div className="hx-chat-avatar" aria-hidden="true">{message.kind==='ai'?<Icon name="sparkle" size={14}/>:(message.authorName||t('Member')).slice(0,1)}</div><div className="hx-chat-message"><div><strong>{message.authorName||(message.kind==='ai'?'AI':t('Member'))}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString(getLocale())}</time></div><div className="hx-chat-body">{renderRich(message.body,()=>'slk-mention')}</div><MessageAppCards text={message.body} api={api}/></div></article>)}</>}
   {source&&messages.length>0&&<div className="hx-chat-origin">{t('Earlier app conversation')}</div>}
   {messages.map(message=><article key={message.id}><div className="hx-chat-avatar" aria-hidden="true">{message.authorId==='__app_ai'?<Icon name="sparkle" size={14}/>:Array.from(message.authorName)[0]}</div><div className="hx-chat-message"><div><strong>{message.authorName}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString(getLocale())}</time></div><div className="hx-chat-body">{renderRich(message.body,()=>'slk-mention')}</div><MessageAppCards text={message.body} api={api}/></div></article>)}
  </div>
  {aiReplies.some(r=>r.status==='running')&&<div className="hx-chat-context" role="status">{t('AI is preparing a reply…')}</div>}
  {aiReplies[0]?.status==='failed'&&<div className="hx-chat-error" role="status">{aiReplies[0].error}</div>}
  {proposals.map(proposal=><section className="hx-chat-context" key={proposal.id} aria-label={t('AI record change proposal')}><strong>{t(({pending:'Proposed change',applying:'Checking change…',applied:'Change applied',undone:'Change undone',rejected:'Proposal declined'} as const)[proposal.status as 'pending'|'applying'|'applied'|'undone'|'rejected']||'Change could not be applied')}</strong><ul>{proposal.fields.map(field=><li key={field.id}><b>{field.name}</b>: {typeof field.value==='string'?field.value:JSON.stringify(field.value)}</li>)}</ul>{proposal.status==='pending'&&(!proposal.expiresAt||Date.parse(proposal.expiresAt)>Date.now())&&<div>{canEditRecord?<><button type="button" className="pill-btn" disabled={Boolean(reviewing)} onClick={()=>void reviewProposal(proposal.id,'approve')}>{reviewing===proposal.id?t('Processing…'):t('Review and apply')}</button> <button type="button" className="pill-btn quiet" disabled={Boolean(reviewing)} onClick={()=>void reviewProposal(proposal.id,'reject')}>{t('Decline')}</button></>:<span>{t('A member with record write access can review this change.')}</span>}</div>}{proposal.status==='applied'&&proposal.appliedUpdatedAt&&canEditRecord&&<button type="button" className="pill-btn quiet" disabled={Boolean(reviewing)} onClick={()=>void reviewProposal(proposal.id,'undo')}>{t('Undo')}</button>}</section>)}
  {!rowId&&!source&&<div className="hx-chat-source"><button type="button" disabled={linking||loading} onClick={()=>void findSources()}><Icon name="link" size={14}/>{t('Carry over a source thread')}</button>{sources&&<div><p>{t('Future messages will also appear in the selected thread. Its existing access rules stay in place.')}</p>{sources.length?<select aria-label={t('Source thread')} defaultValue="" disabled={linking} onChange={e=>{if(e.target.value)void chooseSource(e.target.value)}}><option value="">{t('Choose a thread')}</option>{sources.map(s=><option key={s.id} value={s.id}>{s.channel.startsWith('b:')?'#'+s.channel.slice(2):t('Original conversation')} · {s.body}</option>)}</select>:<p>{t('No selectable threads are available in rooms linked to this app.')}</p>}</div>}</div>}
  {error&&<div className="hx-chat-error" role="alert">{error}<button type="button" onClick={()=>void refresh(epoch.current)}>{t('Reload')}</button></div>}
  {context&&<div className="hx-chat-context">{context}</div>}
  <DraftSuggestion draft={suggestedDraft} onAppend={appendSuggestedDraft} onDismiss={dismissSuggestedDraft}/>
  <form className="hx-chat-compose" onSubmit={e=>void send(e)}>{mentions.menu}<textarea ref={box} onSelect={mentions.track} onClick={mentions.track} aria-label={t('Message input')} placeholder={t('Write a message… @ to mention')} value={draft} maxLength={4000} disabled={sending} rows={3} onChange={e=>{saveDraft(e.target.value);mentions.track()}} onKeyUp={mentions.track} onKeyDown={e=>{if(mentions.onKeyDown(e))return;if(enterKey(e)&&(e.metaKey||e.ctrlKey)){e.preventDefault();e.currentTarget.form?.requestSubmit()}}}/><div><button type="button" className="hx-chat-ai" disabled={sending} onClick={()=>{saveDraft(d=>d.includes('@AI')?d:`@AI ${d}`);box.current?.focus()}}><Icon name="sparkle" size={14}/>{t('Ask AI')}</button><span>{t('Send with {shortcut}',{shortcut:formatCombo('Mod+Enter',isMacPlatform())})}</span><button type="submit" className="hx-chat-send" aria-label={t('Send message')} disabled={sending||loading||!draft.trim()}><Icon name="send" size={16}/></button></div></form>
 </section>
}
