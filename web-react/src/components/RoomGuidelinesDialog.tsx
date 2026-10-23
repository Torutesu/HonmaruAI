import React,{useCallback,useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
import './RoomGuidelinesDialog.css'
type Api={httpBase:string;orgId:string;sessionToken:string}
type Value={body:string;version:number}
class GuidelinesTimeout extends Error {}
// A stalled request must not trap the person in a disabled dialog. Aborting
// a write does not prove it was rolled back: the caller requires a fresh read.
async function boundedRequest<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
 try{return await Promise.race([work(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new GuidelinesTimeout('通信がタイムアウトしました。再読み込みしてください。'));controller.abort()},15000)})])}
 finally{clearTimeout(timer)}
}
export function RoomGuidelinesDialog({api,channel,onClose}:{api:Api;channel:string;onClose:()=>void}){
 const [saved,setSaved]=useState<Value|null>(null),[draft,setDraft]=useState(''),[editable,setEditable]=useState(false)
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false)
 const generation=useRef(0),request=useRef(0),pending=useRef<number|null>(null)
 const load=useCallback(async()=>{
  const scope=generation.current,id=++request.current;setLoading(true);setError('')
  try{
   const data=await boundedRequest(async signal=>{
    const response=await fetch(`${api.httpBase}/hx/rooms/guidelines?${new URLSearchParams({orgId:api.orgId,channel})}`,{headers:{'x-session-token':api.sessionToken},signal})
    if(!response.ok)throw Error('ガイドラインを取得できませんでした。')
    return response.json()
   })
   if(scope!==generation.current||id!==request.current)return
   setSaved(data.guidelines);setDraft(data.guidelines.body);setEditable(data.canEdit===true);setConflict(false)
  }catch(e){if(scope===generation.current&&id===request.current)setError(e instanceof Error?e.message:String(e))}
  finally{if(scope===generation.current&&id===request.current)setLoading(false)}
 },[api.httpBase,api.orgId,api.sessionToken,channel])
 useEffect(()=>{generation.current++;pending.current=null;setBusy(false);setSaved(null);setDraft('');setEditable(false);void load();return()=>{generation.current++;request.current++}},[load])
 const save=async()=>{
  if(pending.current!==null||loading||!editable||!saved||conflict||draft===saved.body)return
  const scope=generation.current;pending.current=scope;setBusy(true);setError('');let received=false
  try{
   const response=await boundedRequest(signal=>fetch(`${api.httpBase}/hx/rooms/guidelines`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':api.sessionToken},body:JSON.stringify({orgId:api.orgId,channel,body:draft,version:saved.version}),signal}));received=true
   if(scope!==generation.current)return
   if(!response.ok){setConflict(response.status===409);throw Error(response.status===409?'ガイドラインまたはメンバー状態が変更されました。入力内容を確認し、最新の内容を再読み込みしてください。':'保存できませんでした。通信状態と編集権限を確認してください。')}
   onClose()
  }catch(e){if(scope===generation.current){
    if(!received){setConflict(true);setError('保存結果を確認できませんでした。入力内容は保持しています。最新の内容を読み込み、保存済みか確認してください。')}
    else setError(e instanceof Error?e.message:String(e))
   }}
  finally{if(pending.current===scope)pending.current=null;if(scope===generation.current)setBusy(false)}
 }
 return <Dialog className="room-guidelines-dialog" title="ルームガイドライン" lede="このルームで協働するメンバーに共有したい背景、ルール、仕事の進め方を記入してください。" onClose={()=>{if(pending.current===null)onClose()}} footer={<><button className="dlg-btn" disabled={busy} onClick={onClose}>キャンセル</button><button className="dlg-btn primary" disabled={busy||loading||!editable||!saved||conflict||draft===saved.body} onClick={()=>void save()}>{busy?'保存中…':'保存'}</button></>}>
  {loading&&<p role="status">読み込み中…</p>}
  {saved&&<><textarea autoFocus aria-label="ルームのガイドライン" placeholder="このルームで共同作業するメンバーのために、背景情報やルール、ガイドラインを入力してください" value={draft} maxLength={4096} disabled={busy||loading} readOnly={!editable||conflict} onChange={event=>setDraft(event.target.value)}/><div className="room-guidelines-count">{draft.length} / 4096</div>{!editable&&<p>編集するには、このルームへの参加と編集権限が必要です。</p>}</>}
  {error&&<div role="alert" className="room-guidelines-error">{error}{(!saved||conflict)&&<button type="button" className="dlg-btn" disabled={busy||loading} onClick={()=>void load()}>最新の内容に置き換える</button>}</div>}
 </Dialog>
}
