import React,{useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
type Api={httpBase:string;orgId:string;sessionToken:string}
type Preview={snapshot:{title:string;messages:Array<{author:string;body:string;attachmentCount:number}>};digest:string;blocked:boolean;dlp:Array<{id:string;name:string;action:string}>}
type Share={id:string;expiresAt:string}
export function ThreadShare({api,channel,threadId,onClose}:{api:Api;channel:string;threadId:string;onClose:()=>void}){
 const [preview,setPreview]=useState<Preview|null>(null),[policy,setPolicy]=useState<{enabled:boolean;version:number}|null>(null),[manage,setManage]=useState(false)
 const [shares,setShares]=useState<Share[]>([]),[confirmed,setConfirmed]=useState(false),[ack,setAck]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[link,setLink]=useState<{id:string;url:string}|null>(null),[copied,setCopied]=useState(false),[policyChoice,setPolicyChoice]=useState(false)
 const live=useRef(true),writing=useRef(false)
 useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 const request=async(path:string,method='GET',body?:unknown,signal?:AbortSignal)=>{
  const controller=signal?null:new AbortController(),timer=controller?setTimeout(()=>controller.abort(),15000):null
  try{
   const response=await fetch(`${api.httpBase}${path}`,{method,headers:{'x-session-token':api.sessionToken,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:signal||controller!.signal})
   const value=await response.json()
   if(!response.ok)throw Object.assign(new Error('request'),{status:response.status})
   return value
  }finally{if(timer)clearTimeout(timer)}
 }
 useEffect(()=>{
  let current=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000)
  setPreview(null);setPolicy(null);setError('');setConfirmed(false);setAck(false)
  const query=new URLSearchParams({orgId:api.orgId,channel,messageId:threadId})
  void Promise.all([request(`/channels/thread/share-preview?${query}`,'GET',undefined,controller.signal),request(`/channels/thread-sharing?${query}`,'GET',undefined,controller.signal),request(`/channels/thread/shares?${query}`,'GET',undefined,controller.signal)])
   .then(([p,settings,owned])=>{if(current){setPreview(p);setPolicy(settings.policy);setPolicyChoice(settings.policy.enabled);setManage(settings.canManage);setShares(owned.shares)}})
   .catch(()=>{if(current)setError('共有内容を読み込めませんでした。')}).finally(()=>clearTimeout(timer))
  return()=>{current=false;controller.abort();clearTimeout(timer)}
 },[api.httpBase,api.orgId,api.sessionToken,channel,threadId,attempt])
 const mutate=async(action:()=>Promise<void>)=>{
  if(writing.current)return
  writing.current=true;setBusy(true);setError('')
  try{await action()}catch(e){if(live.current)setError((e as any).status===409?'内容または設定が変わりました。再読み込みして確認してください。':'処理できませんでした。通信状態と権限を確認してください。')}
  finally{writing.current=false;if(live.current)setBusy(false)}
 }
 const publish=()=>mutate(async()=>{
  if(!preview||!policy?.enabled||!confirmed||preview.blocked)return
  const result=await request('/channels/thread/shares','POST',{orgId:api.orgId,channel,messageId:threadId,digest:preview.digest,confirmPublic:true,acknowledgeWarnings:ack})
  if(!live.current)return
  setShares(previous=>[result,...previous]);setLink({id:result.id,url:`${location.origin}${location.pathname}#/shared/${result.token}`});setCopied(false);setConfirmed(false)
 })
 const revoke=(id:string)=>mutate(async()=>{
  await request('/channels/thread/shares','DELETE',{orgId:api.orgId,id})
  if(live.current){setShares(previous=>previous.filter(s=>s.id!==id));if(link?.id===id)setLink(null)}
 })
 const savePolicy=()=>mutate(async()=>{
  if(!policy)return
  const result=await request('/channels/thread-sharing','PUT',{orgId:api.orgId,enabled:policyChoice,version:policy.version})
  if(live.current){setPolicy(result.policy);setShares([]);setLink(null);setConfirmed(false)}
 })
 const copy=async()=>{try{await navigator.clipboard.writeText(link!.url);if(live.current)setCopied(true)}catch{if(live.current)setError('コピーできませんでした。リンクを選択してコピーしてください。')}}
 return <Dialog title={preview?`「${preview.snapshot.title}」を共有`:'共有'} lede="共有後に追加されたメッセージはこのリンクに表示されません。" onClose={()=>{if(!busy)onClose()}} className="hx-thread-share">
  {!preview&&!error&&<p role="status">読み込み中…</p>}
  {preview&&<div className="hx-thread-share-preview">{preview.snapshot.messages.map((message,index)=><article key={index}><strong>{message.author}</strong><p>{message.body}</p>{message.attachmentCount>0&&<small>添付 {message.attachmentCount} 件は公開されません。</small>}</article>)}</div>}
  {manage&&policy&&<details><summary>組織の公開共有設定</summary><label><input type="checkbox" checked={policyChoice} disabled={busy} onChange={event=>setPolicyChoice(event.target.checked)}/>ワークスペースで公開共有を許可</label><p>設定を保存すると既存の公開リンクをすべて無効化します。</p><button type="button" disabled={busy||policyChoice===policy.enabled} onClick={()=>void savePolicy()}>設定を保存</button></details>}
  {policy&&!policy.enabled&&<p>このワークスペースでは公開共有が無効です。管理者が許可する必要があります。</p>}
  {preview?.dlp.length? <div role="status"><p>{preview.blocked?'組織のルールにより公開できません。':'公開前に確認が必要です。'}</p><ul>{preview.dlp.map(rule=><li key={rule.id}>{rule.name}</li>)}</ul>{!preview.blocked&&<label><input type="checkbox" checked={ack} disabled={busy} onChange={event=>setAck(event.target.checked)}/>警告を確認しました</label>}</div>:null}
  {policy?.enabled&&preview&&!preview.blocked&&<div className="hx-thread-share-publish"><label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/>リンクを知っている人は誰でも、この会話を7日間閲覧できることを確認しました。</label><button type="button" disabled={busy||!confirmed||(!!preview.dlp.length&&!ack)} onClick={()=>void publish()}>公開リンクを作成</button></div>}
  {link&&<div className="hx-thread-share-link"><input aria-label="公開リンク" readOnly value={link.url} onFocus={event=>event.target.select()}/><button type="button" onClick={()=>void copy()}>{copied?'コピーしました':'リンクをコピー'}</button></div>}
  {shares.length>0&&<details><summary>自分が作成した有効なリンク（{shares.length}）</summary>{shares.map(share=><div key={share.id} className="hx-thread-share-owned"><span>期限：{new Date(share.expiresAt).toLocaleString()}</span><button type="button" disabled={busy} onClick={()=>void revoke(share.id)}>無効化</button></div>)}</details>}
  {error&&<p role="alert">{error}<button type="button" disabled={busy} onClick={()=>setAttempt(n=>n+1)}>再読み込み</button></p>}
 </Dialog>
}
