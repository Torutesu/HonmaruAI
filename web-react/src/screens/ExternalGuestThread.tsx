import React,{useEffect,useState} from 'react'
import {useT} from '../utils/i18n'
import {EmojiPicker,EmojiGlyph} from '../components/MessageParts'
import {Icon} from '../components/Icon'
import {CUSTOM_EMOJI} from '../utils/customEmoji'
import './ExternalGuestThread.css'

type GuestFile={id:string;name:string;type:string;size:number;url?:string}
type GuestReaction={emoji:string;count:number;mine:boolean}
type Message={id:string;body:string;authorName:string|null;mine:boolean;createdAt:string;parentId:string|null;files?:GuestFile[];reactions?:GuestReaction[]}
type ThreadData={permission:'view'|'edit';thread:{parent:Message;replies:Message[]}}
export function ExternalGuestThread({httpBase,orgId,rootId,sessionToken}:{httpBase:string;orgId:string;rootId:string;sessionToken:string}){
  const t=useT()
  const [data,setData]=useState<ThreadData|null>(null)
  const [body,setBody]=useState('')
  const [uploads,setUploads]=useState<GuestFile[]>([])
  const [pickerFor,setPickerFor]=useState<string|null>(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [attempt,setAttempt]=useState(0)
  useEffect(()=>{
    let live=true
    let pending:AbortController|null=null
    const doc=typeof document==='undefined'?null:document
    const load=()=>{
      if(!live||doc?.visibilityState==='hidden'||pending)return
      const controller=new AbortController()
      pending=controller
      void fetch(`${httpBase}/external/threads/${encodeURIComponent(orgId)}/${encodeURIComponent(rootId)}`,{
        headers:{'x-session-token':sessionToken},cache:'no-store',signal:controller.signal,
      }).then(async response=>{
        const value=await response.json().catch(()=>({}))
        if(!live||controller.signal.aborted)return
        if(!response.ok){
          if([401,403,404].includes(response.status))setData(null)
          throw new Error(response.status===404?t('This Thread is unavailable or access has expired.'):value.message||t('Could not load this Thread.'))
        }
        setData(value)
        setError('')
      }).catch(reason=>{
        if(live&&!controller.signal.aborted)setError(reason instanceof Error?reason.message:t('Could not load this Thread.'))
      }).finally(()=>{if(pending===controller)pending=null})
    }
    const onVisibility=()=>{
      if(doc?.visibilityState==='hidden'){
        pending?.abort()
        pending=null
      }else load()
    }
    setError('')
    load()
    const interval=globalThis.setInterval(load,5000)
    doc?.addEventListener('visibilitychange',onVisibility)
    return()=>{
      live=false
      globalThis.clearInterval(interval)
      doc?.removeEventListener('visibilitychange',onVisibility)
      pending?.abort()
    }
  },[httpBase,orgId,rootId,sessionToken,attempt])
  const upload=async(event:React.ChangeEvent<HTMLInputElement>)=>{
    const selected=Array.from(event.target.files||[])
    event.target.value=''
    if(!selected.length||busy)return
    if(uploads.length+selected.length>10){setError(t('A message can carry at most 10 files.'));return}
    setBusy(true);setError('');setNotice('')
    try{
      for(const file of selected){
        const response=await fetch(`${httpBase}/external/threads/${encodeURIComponent(orgId)}/${encodeURIComponent(rootId)}/files?name=${encodeURIComponent(file.name)}`,{
          method:'POST',headers:{'x-session-token':sessionToken,'content-type':file.type||'application/octet-stream'},body:file,cache:'no-store',
        })
        const value=await response.json().catch(()=>({}))
        if(!response.ok||!value.file?.id)throw new Error(value.message||t('Could not upload this file.'))
        setUploads(previous=>[...previous,value.file])
      }
      setNotice(t('Files uploaded. Attach them to your reply before sending.'))
    }catch(reason){setError(reason instanceof Error?reason.message:t('Could not upload this file.'))}
    finally{setBusy(false)}
  }
  const removeUpload=(id:string)=>setUploads(previous=>previous.filter(file=>file.id!==id))
  const download=async(file:GuestFile)=>{
    if(!file.url)return
    try{
      const response=await fetch(`${httpBase}${file.url}`,{headers:{'x-session-token':sessionToken},cache:'no-store'})
      if(!response.ok)throw new Error(t('Could not download this file.'))
      const objectUrl=URL.createObjectURL(await response.blob())
      const anchor=document.createElement('a');anchor.href=objectUrl;anchor.download=file.name;anchor.rel='noopener';anchor.click()
      globalThis.setTimeout(()=>URL.revokeObjectURL(objectUrl),1000)
    }catch(reason){setError(reason instanceof Error?reason.message:t('Could not download this file.'))}
  }
  const react=async(messageId:string,emoji:string)=>{
    setError('')
    try{
      const response=await fetch(`${httpBase}/external/threads/${encodeURIComponent(orgId)}/${encodeURIComponent(rootId)}/reactions`,{
        method:'POST',headers:{'content-type':'application/json','x-session-token':sessionToken},
        body:JSON.stringify({messageId,emoji}),cache:'no-store',
      })
      const value=await response.json().catch(()=>({}))
      if(!response.ok||!Array.isArray(value.reactions))throw new Error(value.message||t('Could not update this reaction.'))
      setData(current=>current?{...current,thread:{parent:current.thread.parent.id===messageId?{...current.thread.parent,reactions:value.reactions}:current.thread.parent,replies:current.thread.replies.map(message=>message.id===messageId?{...message,reactions:value.reactions}:message)}}:current)
    }catch(reason){setError(reason instanceof Error?reason.message:t('Could not update this reaction.'))}
  }
  const send=async(event:React.FormEvent)=>{
    event.preventDefault()
    const message=body.trim()
    if(!message||busy)return
    setBusy(true);setError('');setNotice('')
    try{
      const response=await fetch(`${httpBase}/external/threads/${encodeURIComponent(orgId)}/${encodeURIComponent(rootId)}`,{
        method:'POST',headers:{'content-type':'application/json','x-session-token':sessionToken},
        body:JSON.stringify({body:message,...(data?.permission==='view'?{requestSend:true}:uploads.length?{files:uploads.map(file=>file.id)}:{})}),
      })
      const value=await response.json().catch(()=>({}))
      if(!response.ok)throw new Error(value.message||t('Could not send this reply.'))
      setBody('');setUploads([])
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
        {!!message.files?.length&&<ul className="hx-external-guest-thread-files" aria-label={t('Attachments')}>{message.files.map(file=><li key={file.id}><button type="button" onClick={()=>void download(file)}>{file.name}</button><small>{file.size} B</small></li>)}</ul>}
        <div className="hx-external-guest-thread-reactions" role="group" aria-label={t('Reactions')}>
          {(message.reactions||[]).filter(reaction=>!CUSTOM_EMOJI.test(reaction.emoji)).map(reaction=><button type="button" key={reaction.emoji} className={`slk-reaction${reaction.mine?' mine':''}`} aria-pressed={reaction.mine} aria-label={t('React with {emoji}',{emoji:reaction.emoji})} data-reaction-emoji={reaction.emoji} onClick={()=>void react(message.id,reaction.emoji)}><EmojiGlyph emoji={reaction.emoji}/><span className="slk-reaction-count">{reaction.count}</span></button>)}
          <button type="button" className="slk-reaction add" aria-label={t('Add reaction')} aria-expanded={pickerFor===message.id} onClick={()=>setPickerFor(current=>current===message.id?null:message.id)}><Icon name="smile" size={14}/><span aria-hidden="true">+</span></button>
        </div>
        {pickerFor===message.id&&<div className="hx-external-guest-thread-picker"><EmojiPicker allowWorkspaceEmoji={false} onPick={emoji=>{setPickerFor(null);void react(message.id,emoji)}} onClose={()=>setPickerFor(null)}/></div>}
      </li>)}</ol>}
      {notice&&<p role="status">{notice}</p>}
      {data&&<form onSubmit={send}>
        <label htmlFor="external-thread-reply">{data.permission==='edit'?t('Reply'):t('Request to reply')}</label>
        {data.permission==='edit'&&<div className="hx-external-guest-thread-upload"><label htmlFor="external-thread-files">{t('Attachments')}</label><input id="external-thread-files" type="file" multiple disabled={busy} onChange={event=>void upload(event)}/>{uploads.length>0&&<ul aria-label={t('Attachments')}>{uploads.map(file=><li key={file.id}><span>{file.name}</span><button type="button" onClick={()=>removeUpload(file.id)} disabled={busy}>{t('Remove')}</button></li>)}</ul>}</div>}
        <textarea id="external-thread-reply" rows={4} maxLength={4000} value={body} onChange={event=>setBody(event.target.value)} placeholder={t('Write a reply…')} disabled={busy}/>
        <button type="submit" disabled={busy||!body.trim()}>{busy?t('Sending…'):data.permission==='edit'?t('Send reply'):t('Request approval')}</button>
      </form>}
    </section>
  </main>
}
