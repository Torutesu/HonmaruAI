import React,{useEffect,useState} from 'react'
import {useT} from '../utils/i18n'
import './ExternalGuestThread.css'

type Message={id:string;body:string;authorName:string|null;mine:boolean;createdAt:string;parentId:string|null}
type ThreadData={permission:'view'|'edit';thread:{parent:Message;replies:Message[]}}
export function ExternalGuestThread({httpBase,orgId,rootId,sessionToken}:{httpBase:string;orgId:string;rootId:string;sessionToken:string}){
  const t=useT()
  const [data,setData]=useState<ThreadData|null>(null)
  const [body,setBody]=useState('')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [attempt,setAttempt]=useState(0)
  useEffect(()=>{
    const controller=new AbortController()
    setError('')
    void fetch(`${httpBase}/external/threads/${encodeURIComponent(orgId)}/${encodeURIComponent(rootId)}`,{
      headers:{'x-session-token':sessionToken},cache:'no-store',signal:controller.signal,
    }).then(async response=>{
      const value=await response.json().catch(()=>({}))
      if(!response.ok)throw new Error(response.status===404?t('This Thread is unavailable or access has expired.'):value.message||t('Could not load this Thread.'))
      setData(value)
    }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:t('Could not load this Thread.'))})
    return()=>controller.abort()
  },[httpBase,orgId,rootId,sessionToken,attempt])
  const send=async(event:React.FormEvent)=>{
    event.preventDefault()
    const message=body.trim()
    if(!message||busy)return
    setBusy(true);setError('');setNotice('')
    try{
      const response=await fetch(`${httpBase}/external/threads/${encodeURIComponent(orgId)}/${encodeURIComponent(rootId)}`,{
        method:'POST',headers:{'content-type':'application/json','x-session-token':sessionToken},
        body:JSON.stringify({body:message,...(data?.permission==='view'?{requestSend:true}:{})}),
      })
      const value=await response.json().catch(()=>({}))
      if(!response.ok)throw new Error(value.message||t('Could not send this reply.'))
      setBody('')
      if(data?.permission==='view')setNotice(t('Your reply request was sent to the Thread owner.'))
      else setAttempt(n=>n+1)
    }catch(reason){setError(reason instanceof Error?reason.message:t('Could not send this reply.'))}
    finally{setBusy(false)}
  }
  const messages=data?[data.thread.parent,...data.thread.replies]:[]
  return <main className="hx-external-guest-thread">
    <header><a href="#/feed" aria-label={t('Back to Honmaru')}>{t('Honmaru')}</a><span>{t('Shared Thread')}</span></header>
    <section className="hx-external-guest-thread-body">
      <p className="hx-external-guest-thread-access">{data?.permission==='edit'?t('You can reply to this Thread.'):t('You can view this Thread. Replies require owner approval.')}</p>
      {error&&<p role="alert" className="form-error">{error}<button type="button" onClick={()=>setAttempt(n=>n+1)}>{t('Retry')}</button></p>}
      {!data&&!error&&<p role="status">{t('Loading Thread…')}</p>}
      {data&&<ol aria-label={t('Thread messages')}>{messages.map((message,index)=><li key={message.id} className={index===0?'root':''}>
        <div><strong>{message.authorName||t('Honmaru AI')}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></div>
        <p>{message.body}</p>
      </li>)}</ol>}
      {notice&&<p role="status">{notice}</p>}
      {data&&<form onSubmit={send}>
        <label htmlFor="external-thread-reply">{data.permission==='edit'?t('Reply'):t('Request to reply')}</label>
        <textarea id="external-thread-reply" rows={4} maxLength={4000} value={body} onChange={event=>setBody(event.target.value)} placeholder={t('Write a reply…')} disabled={busy}/>
        <button type="submit" disabled={busy||!body.trim()}>{busy?t('Sending…'):data.permission==='edit'?t('Send reply'):t('Request approval')}</button>
      </form>}
    </section>
  </main>
}
