import React,{useEffect,useRef,useState} from 'react'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import type {WorkspaceFileApi} from '../utils/workspaceFiles'

type Job={file:File;path:string;id?:string;requestId?:string;state:'waiting'|'uploading'|'saved'|'failed';error?:string}
export function WorkspaceFileUpload({api,scope,onSaved}:{api:WorkspaceFileApi;scope:string;onSaved:()=>void}){
 const t=useT(),input=useRef<HTMLInputElement>(null),folder=useRef<HTMLInputElement>(null),running=useRef(false)
 const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null)
 const [jobs,setJobs]=useState<Job[]>([]),[busy,setBusy]=useState(false),[menu,setMenu]=useState(false)
 useEffect(()=>{if(!menu)return;const dismiss=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setMenu(false)};document.addEventListener('pointerdown',dismiss);return()=>document.removeEventListener('pointerdown',dismiss)},[menu])
 const lifetime=useRef<AbortController|null>(null)
 useEffect(()=>{const controller=new AbortController();lifetime.current=controller;return()=>{controller.abort();lifetime.current=null}},[api,scope])
 const run=async(batch:Job[])=>{
  if(running.current)return
  const controller=lifetime.current;if(!controller)return
  running.current=true;setBusy(true);setMenu(false)
  const publish=()=>{if(!controller.signal.aborted)setJobs([...batch])}
  for(const job of batch){
   if(controller.signal.aborted)break
   if(job.state==='saved')continue
   job.state='uploading';job.error=undefined;publish()
   try{
    if(job.file.size>25*1024*1024)throw new Error(t('Files must be 25 MB or smaller.'))
    if(!job.id){job.requestId??=`file-${crypto.randomUUID()}`;const created=await api.create(scope,job.path,job.requestId);job.id=created.id}
    if(controller.signal.aborted)break
    await api.upload(job.id,0,job.file,controller.signal)
    job.state='saved';if(!controller.signal.aborted)onSaved()
   }catch(error){job.state='failed';job.error=error instanceof Error?error.message:String(error)}
   publish()
  }
  running.current=false;if(!controller.signal.aborted)setBusy(false)
 }
 const choose=(event:React.ChangeEvent<HTMLInputElement>)=>{const files=Array.from(event.target.files||[]);event.target.value='';if(files.length)void run(files.map(file=>({file,path:file.webkitRelativePath||file.name,state:'waiting'})))}
 return <div className="hx-files-upload" ref={root} onKeyDown={event=>{if(event.key==='Escape'&&menu){event.stopPropagation();setMenu(false);trigger.current?.focus()}}}>
  <input hidden type="file" multiple ref={input} onChange={choose}/>
  <input hidden type="file" multiple ref={folder} {...{webkitdirectory:''}} onChange={choose}/>
  <button ref={trigger} type="button" disabled={busy} aria-label={t('Upload files')} aria-expanded={menu} onClick={()=>setMenu(value=>!value)}><Icon name="upload" size={16}/></button>
  {menu&&<div className="hx-files-upload-menu"><button autoFocus onClick={()=>{setMenu(false);input.current?.click()}}>{t('Upload files')}</button><button onClick={()=>{setMenu(false);folder.current?.click()}}>{t('Upload folder')}</button></div>}
  {!!jobs.length&&<div className="hx-files-upload-status" aria-live="polite">{jobs.map((job,index)=><div key={index}><span>{job.path}</span><small>{t(job.state==='saved'?'Uploaded':job.state==='failed'?'Upload failed':job.state==='uploading'?'Uploading…':'Queued for upload')}</small>{job.error&&<p role="alert">{job.error}</p>}</div>)}{!busy&&jobs.some(job=>job.state==='failed')&&<button onClick={()=>void run(jobs)}>{t('Retry failed uploads')}</button>}{!busy&&<button onClick={()=>setJobs([])}>{t('Dismiss')}</button>}</div>}
 </div>
}
