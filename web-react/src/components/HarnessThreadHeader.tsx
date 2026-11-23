import React,{useEffect,useRef,useState} from 'react'
import type {ChannelMessage} from '../types/card'
import {Icon} from './Icon'
import {RowMenu} from './RowMenu'
import {Dialog} from './Dialog'
import {previewText} from '../utils/messageKeys'
import {ThreadSearch} from './ThreadSearch'
import {useThreadNotifications} from '../utils/useThreadNotifications'
import {ThreadShare} from './ThreadShare'
import {ExternalThreadShare} from './ExternalThreadShare'
import {hashForThread} from '../utils/route'
import {t} from '../utils/i18n'

type Api={httpBase:string;orgId:string;sessionToken:string}
export function HarnessThreadHeader({api,channel,parent,room,onClose,onParent,pin,references,onSearchSelect}:{onSearchSelect?:(message:ChannelMessage)=>void;references?:{open:boolean;onToggle:()=>void};pin?:{pinned:boolean;disabled:boolean;error?:string;onRetry?:()=>void;onToggle:()=>void};api:Api;channel:string;parent:ChannelMessage;room:string;onClose:()=>void;onParent:(parent:ChannelMessage)=>void}){
 const [search,setSearch]=useState(false),[sharing,setSharing]=useState(false),[externalSharing,setExternalSharing]=useState(false)
 const [desktop,setDesktop]=useState(false),[desktopSessions,setDesktopSessions]=useState<string[]>([]),[desktopJob,setDesktopJob]=useState(''),[desktopImage,setDesktopImage]=useState(''),[desktopError,setDesktopError]=useState(''),[desktopCanControl,setDesktopCanControl]=useState(false),[desktopText,setDesktopText]=useState(''),[desktopStatus,setDesktopStatus]=useState('')
 const desktopImageRef=useRef<HTMLImageElement|null>(null)
 const desktopJobRef=useRef('');desktopJobRef.current=desktopJob
 useEffect(()=>{
  if(!onSearchSelect)return
  const key=(event:KeyboardEvent)=>{if(!event.defaultPrevented&&(event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='f'){event.preventDefault();setMenu(null);setSearch(true)}}
  window.addEventListener('keydown',key)
  return()=>window.removeEventListener('keydown',key)
 },[onSearchSelect])
 const [copyState,setCopyState]=useState<{url:string;copied:boolean}|null>(null)
 const [menu,setMenu]=useState<{x:number;y:number;anchor:HTMLElement}|null>(null)
 const notifications=useThreadNotifications(api,channel,parent.id,!!menu)
 const [edit,setEdit]=useState<{text:string;version:number}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false)
 const scope=`${api.httpBase}:${api.orgId}:${api.sessionToken}:${parent.id}`,currentScope=useRef(scope);currentScope.current=scope
 const live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 const title=parent.threadTitle||previewText(parent.body)||'スレッド'
 useEffect(()=>{
  if(!desktop)return
  let active=true
  const query=new URLSearchParams({orgId:api.orgId,channel,threadId:parent.id})
  fetch(`${api.httpBase}/hx/browser-sessions?${query}`,{headers:{'x-session-token':api.sessionToken}}).then(async response=>{
   const result=await response.json()
   if(!response.ok)throw new Error('実行中のブラウザーを確認できませんでした。')
   if(active)setDesktopSessions(Array.isArray(result.sessions)?result.sessions.map((item:{id:string})=>item.id):[])
  }).catch(()=>{if(active)setDesktopError('実行中のブラウザーを確認できませんでした。')})
  const frame=(event:Event)=>{const value=(event as CustomEvent<{jobId:string;image:string}>).detail;if(active&&value?.jobId===desktopJobRef.current&&value.image)setDesktopImage(`data:image/jpeg;base64,${value.image}`)}
  const unavailable=(event:Event)=>{const value=(event as CustomEvent<{jobId:string}>).detail;if(active&&value?.jobId===desktopJobRef.current)setDesktopError('このブラウザーを表示する権限がなくなりました。')}
  const ready=(event:Event)=>{const value=(event as CustomEvent<{jobId:string;canControl:boolean}>).detail;if(active&&value?.jobId===desktopJobRef.current){setDesktopCanControl(Boolean(value.canControl));setDesktopStatus(value.canControl?t('This browser can be controlled by people in the conversation, one at a time.'):'This browser is visible to this conversation.')}}
  const queued=(event:Event)=>{const value=(event as CustomEvent<{jobId:string}>).detail;if(active&&value?.jobId===desktopJobRef.current)setDesktopStatus('操作を送信しました。ブラウザーの応答を待っています。')}
  const rejected=(event:Event)=>{const value=(event as CustomEvent<{jobId:string}>).detail;if(active&&value?.jobId===desktopJobRef.current)setDesktopStatus(t('Another person may be controlling the browser, or your conversation access may have changed.'))}
  window.addEventListener('honmaru:browser-frame',frame);window.addEventListener('honmaru:browser-frame-unavailable',unavailable);window.addEventListener('honmaru:browser-frame-ready',ready);window.addEventListener('honmaru:browser-control-queued',queued);window.addEventListener('honmaru:browser-control-rejected',rejected)
  return()=>{active=false;window.removeEventListener('honmaru:browser-frame',frame);window.removeEventListener('honmaru:browser-frame-unavailable',unavailable);window.removeEventListener('honmaru:browser-frame-ready',ready);window.removeEventListener('honmaru:browser-control-queued',queued);window.removeEventListener('honmaru:browser-control-rejected',rejected)}
 },[desktop,api.httpBase,api.orgId,api.sessionToken,channel,parent.id,desktopJob])
 const sendDesktopControl=(action:unknown)=>{if(!desktopCanControl||!desktopJob)return;window.dispatchEvent(new CustomEvent('honmaru:desktop-control',{detail:{jobId:desktopJob,action}}))}
 const watchDesktop=(jobId:string)=>{desktopJobRef.current=jobId;setDesktopJob(jobId);setDesktopImage('');setDesktopError('');setDesktopCanControl(false);setDesktopStatus('接続しています…');window.dispatchEvent(new CustomEvent('honmaru:desktop-join',{detail:{jobId}}))}
 const submitDesktopText=(event:React.FormEvent)=>{event.preventDefault();if(!desktopText.trim())return;sendDesktopControl({type:'type',text:desktopText});setDesktopText('')}
 const copy=async()=>{
  const requestedScope=scope,url=`${location.origin}${location.pathname}${hashForThread(parent.id,api.orgId)}`
  let copied=false
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(url);copied=true}}catch{}
  if(live.current&&currentScope.current===requestedScope)setCopyState({url,copied})
 }
 const begin=()=>{setMenu(null);setError('');setConflict(false);setEdit({text:title.slice(0,160),version:parent.threadTitleVersion||0})}
 const save=async()=>{
  if(!edit||busy)return
  const requestedScope=scope
  setBusy(true);setError('');setConflict(false)
  try{
   const response=await fetch(`${api.httpBase}/channels/thread/title`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':api.sessionToken},body:JSON.stringify({orgId:api.orgId,channel,messageId:parent.id,title:edit.text,version:edit.version})})
   const result=await response.json()
   if(!live.current||currentScope.current!==requestedScope)return
   if(!response.ok){setConflict(response.status===409);setError(response.status===409?'別の端末で名前が変更されました。最新の名前を確認してください。':'名前を保存できませんでした。');return}
   onParent(result.parent);setEdit(null)
   window.dispatchEvent(new CustomEvent('honmaru:channel-message',{detail:result.parent}))
  }catch(e){if(live.current&&currentScope.current===requestedScope)setError('名前を保存できませんでした。通信状態を確認して再試行してください。')}
  finally{if(live.current&&currentScope.current===requestedScope)setBusy(false)}
 }
 const reload=async()=>{
  const requestedScope=scope
  setBusy(true)
  try{
   const query=new URLSearchParams({orgId:api.orgId,channel,messageId:parent.id,limit:'50'})
   const response=await fetch(`${api.httpBase}/channels/thread?${query}`,{headers:{'x-session-token':api.sessionToken}})
   if(!response.ok)throw new Error('最新の名前を確認できませんでした。')
   const result=await response.json();if(!live.current||currentScope.current!==requestedScope)return
   onParent(result.parent);setEdit(previous=>previous?{...previous,version:result.parent.threadTitleVersion||0}:null);setConflict(false);setError(`現在の名前: ${result.parent.threadTitle||previewText(result.parent.body)}。入力中の名前で保存できます。`)
  }catch(e){if(live.current&&currentScope.current===requestedScope)setError('最新の名前を確認できませんでした。通信状態を確認して再試行してください。')}
  finally{if(live.current&&currentScope.current===requestedScope)setBusy(false)}
 }
 return <><header className="slk-pane-head hx-thread-heading"><div className="hx-thread-heading-text"><button className="hx-thread-room" type="button" onClick={onClose} aria-label={`${room}に戻る`} title={room}><Icon name="chevron-left" size={12}/><Icon name="message" size={12}/><span>{room}</span></button><h2 title={title}>{title}</h2></div><button type="button" className="hx-thread-options" aria-label="ブラウザー画面" title="実行中のブラウザー画面を表示" onClick={()=>{setDesktop(true);setDesktopError('');setDesktopSessions([])}}><Icon name="monitor" size={18}/></button>{references&&<button type="button" className="hx-thread-options" aria-label="参照" title="参照" aria-expanded={references.open} onClick={references.onToggle}><Icon name="file" size={18}/></button>}{pin&&<button type="button" className="hx-thread-options" aria-label={pin.pinned?"ホームへの固定を解除":"スレッドをホームに固定"} title={pin.pinned?"ホームへの固定を解除":"スレッドをホームに固定"} aria-pressed={pin.pinned} disabled={pin.disabled} onClick={pin.onToggle}><Icon name="pin" size={18}/></button>}<button type="button" className="hx-thread-options" aria-label="スレッドのリンクをコピー" title="スレッドのリンクをコピー" onClick={()=>void copy()}><Icon name="link" size={18}/></button><button type="button" className="hx-thread-options" aria-label="その他のスレッド操作" aria-haspopup="menu" aria-expanded={!!menu} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setMenu({x:rect.left,y:rect.bottom,anchor:event.currentTarget})}}><Icon name="more" size={18}/></button><button type="button" className="slk-pane-close" onClick={onClose} aria-label={`${room}に戻る`}><Icon name="x" size={16}/></button> {search&&onSearchSelect&&<ThreadSearch api={api} channel={channel} threadId={parent.id} onClose={()=>setSearch(false)} onSelect={onSearchSelect}/>}</header>
 {desktop&&<Dialog title="ブラウザー画面" onClose={()=>{desktopJobRef.current='';setDesktop(false);setDesktopImage('');setDesktopJob('');setDesktopCanControl(false)}} footer={<button type="button" onClick={()=>{desktopJobRef.current='';setDesktop(false);setDesktopImage('');setDesktopJob('');setDesktopCanControl(false)}}>閉じる</button>}><p>このスレッドで実行中のブラウザー画面です。画像は一時配信され、保存されません。</p>{desktopSessions.length?desktopSessions.map(jobId=><button key={jobId} type="button" onClick={()=>watchDesktop(jobId)} aria-pressed={desktopJob===jobId}>実行中のブラウザーを表示</button>):<p>表示できる実行中のブラウザーはありません。</p>}{desktopError&&<p role="status">{desktopError}</p>}{desktopStatus&&<p role="status">{desktopStatus}</p>}{desktopImage&&<><img ref={desktopImageRef} alt={desktopCanControl?'クリックしてブラウザーを操作':'実行中ブラウザーの画面'} src={desktopImage} onClick={event=>{if(!desktopCanControl)return;const rect=event.currentTarget.getBoundingClientRect();if(rect.width&&rect.height)sendDesktopControl({type:'click',x:Math.round((event.clientX-rect.left)*1280/rect.width),y:Math.round((event.clientY-rect.top)*800/rect.height)})}} onWheel={event=>{if(!desktopCanControl)return;event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();if(rect.width&&rect.height)sendDesktopControl({type:'scroll',x:Math.round((event.clientX-rect.left)*1280/rect.width),y:Math.round((event.clientY-rect.top)*800/rect.height),deltaX:event.deltaX,deltaY:event.deltaY})}} style={{display:'block',width:'100%',maxHeight:'65vh',objectFit:'contain',background:'#111',marginTop:12,cursor:desktopCanControl?'crosshair':'default'}}/>{desktopCanControl&&<form onSubmit={submitDesktopText} style={{display:'flex',gap:8,marginTop:12}}><input aria-label="ブラウザーに入力する文字" autoComplete="off" maxLength={2000} value={desktopText} onChange={event=>setDesktopText(event.target.value)} placeholder="ページへ文字を入力"/><button type="submit" disabled={!desktopText.trim()}>入力</button><button type="button" onClick={()=>sendDesktopControl({type:'press',key:'Enter'})}>Enter</button></form>}</>}</Dialog>}
 {notifications.error&&<p className="hx-thread-pin-error" role="status">{notifications.error}</p>}
 {pin?.error&&<p className="hx-thread-pin-error" role="status">{pin.error}<button type="button" onClick={pin.onRetry}>再試行</button></p>}
 {menu&&<RowMenu at={menu} anchor={menu.anchor} label="その他のスレッド操作" onClose={()=>setMenu(null)} entries={[{kind:'item',label:'外部ユーザーと共有',icon:'share',onSelect:()=>{setMenu(null);setExternalSharing(true)}},{kind:'item',label:'公開リンクを管理',icon:'link',onSelect:()=>{setMenu(null);setSharing(true)}},{kind:'item',label:notifications.busy?'通知設定を保存中…':notifications.muted===null?(notifications.error?'通知設定を取得できません':'通知設定を読み込み中…'):notifications.muted?'スレッドのミュートを解除':'スレッドをミュート',icon:notifications.muted?'bell':'bell-off',disabled:notifications.busy||notifications.muted===null,onSelect:()=>{setMenu(null);void notifications.toggle()}},{kind:'item',label:notifications.busy?t('Saving thread status…'):notifications.left===null?t('Loading thread status…'):notifications.left?t('Follow thread'):t('Leave thread'),icon:'message',disabled:notifications.busy||notifications.left===null,onSelect:()=>{setMenu(null);void notifications.toggleLeft()}},...(onSearchSelect?[{kind:'item' as const,label:t('Search within thread'),icon:'search' as const,onSelect:()=>{setMenu(null);setSearch(true)}}]:[]),...(parent.canRenameThread?[{kind:'item' as const,label:'スレッド名を変更',icon:'edit' as const,onSelect:begin}]:[]),{kind:'item',label:`${room}で表示`,icon:'message',onSelect:onClose}]}/>}
 {sharing&&<ThreadShare api={api} channel={channel} threadId={parent.id} onClose={()=>setSharing(false)}/>}{externalSharing&&<ExternalThreadShare api={api} threadId={parent.id} onClose={()=>setExternalSharing(false)}/>}
 {copyState&&<Dialog title={copyState.copied?"リンクをコピーしました":"スレッドのリンク"} onClose={()=>setCopyState(null)} footer={<button type="button" onClick={()=>setCopyState(null)}>閉じる</button>}><p>{copyState.copied?"この会話を閲覧できるメンバーが開けます。":"コピーできませんでした。次のリンクを選択してコピーしてください。"}</p><input aria-label="スレッドのリンク" readOnly value={copyState.url} onFocus={event=>event.currentTarget.select()}/></Dialog>}
 {edit&&<Dialog title="スレッド名を変更" onClose={()=>{if(!busy)setEdit(null)}} footer={<><button type="button" disabled={busy} onClick={()=>setEdit(null)}>キャンセル</button><button type="button" disabled={busy||!edit.text.trim()||conflict} onClick={()=>void save()}>{busy?'処理中…':'保存'}</button></>}><label>スレッド名<input autoFocus maxLength={160} value={edit.text} disabled={busy} onChange={event=>setEdit({...edit,text:event.target.value})}/></label>{error&&<p role="status">{error}</p>}{conflict&&<button type="button" disabled={busy} onClick={()=>void reload()}>最新の名前を確認</button>}</Dialog>}
 </>
}
