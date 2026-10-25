import {readDocumentReceipt,saveDocumentReceipt} from '../utils/documentReceipt'
import {WorkspaceFileError} from '../utils/workspaceFiles'
import React,{useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import type {WorkspaceFileApi,DocumentJob} from '../utils/workspaceFiles'
import './DocumentCreate.css'
export function DocumentCreate({api,scope,directory='',receiptKey,onOpen}:{api:WorkspaceFileApi;scope:string;directory?:string;receiptKey?:string;onOpen:(id:string)=>void}){
 const t=useT(),[open,setOpen]=useState(false),[nodes,setNodes]=useState<{id:string;name:string}[]|null>(null),[node,setNode]=useState('')
 const [name,setName]=useState(''),[text,setText]=useState(''),[inputFormat,setInputFormat]=useState<'markdown'|'html'>('markdown'),[format,setFormat]=useState<'pdf'|'docx'>('pdf')
 const [job,setJob]=useState<DocumentJob|null>(()=>{const id=readDocumentReceipt(receiptKey);return id?{id,status:'queued',fileId:null,version:null,path:''}:null}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0)
 useEffect(()=>saveDocumentReceipt(receiptKey,job?.id||null),[receiptKey,job?.id])
 const request=useRef<{key:string;id:string}|null>(null),life=useRef<AbortController|null>(null)
 useEffect(()=>{const c=new AbortController();life.current=c;return()=>c.abort()},[api,scope])
 useEffect(()=>{if(!open||job)return;const c=new AbortController();setNodes(null)
  api.documentNodes(c.signal).then(r=>{if(!c.signal.aborted){setNodes(r.nodes);setError('');setNode(old=>r.nodes.some(n=>n.id===old)?old:r.nodes[0]?.id||'')}}).catch(e=>{if(!c.signal.aborted){setNodes([]);setError(e.message)}})
  return()=>c.abort()
 },[api,open,attempt,job?.id])
 const active=job?.status==='queued'||job?.status==='running'
 useEffect(()=>{
  if(!job||!active)return;const c=new AbortController();let timer:ReturnType<typeof setTimeout>
  const poll=async()=>{try{const r=await api.documentJob(job.id,c.signal);if(c.signal.aborted)return;setJob(r.job);setError('');if(['queued','running'].includes(r.job.status))timer=setTimeout(poll,2000)}catch(e){if(!c.signal.aborted){if(e instanceof WorkspaceFileError&&[403,404].includes(e.status))setJob(null);setError(e instanceof Error?e.message:String(e))}}}
  timer=setTimeout(poll,1000);return()=>{clearTimeout(timer);c.abort()}
 },[api,job?.id,active,attempt,open])
 const submit=async()=>{
  if(busy||active||!node||!text.trim()||!name.trim())return
  const c=life.current;if(!c)return;setBusy(true);setError('')
  const path=directory+name.trim().replace(/\.(pdf|docx)$/i,'')+'.'+format,body={scope,path,text,inputFormat,format,gatewayId:node}
  const key=JSON.stringify(body);if(!request.current||request.current.key!==key||job)request.current={key,id:crypto.randomUUID()}
  try{const r=await api.createDocument({...body,requestId:request.current.id},c.signal);if(!c.signal.aborted)setJob(r.job)}catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:String(e))}finally{if(!c.signal.aborted)setBusy(false)}
 }
 const cancel=async()=>{if(!job||busy)return;const c=life.current;if(!c)return;setBusy(true);setError('');try{const r=await api.cancelDocument(job.id,c.signal);if(!c.signal.aborted)setJob(r.job)}catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:String(e))}finally{if(!c.signal.aborted)setBusy(false)}}
 return <><button type="button" className="hx-document-trigger" title={t('Create document')} aria-label={t('Create document')} onClick={()=>setOpen(true)}><Icon name="file" size={16}/></button>{open&&<Dialog title={t('Create document')} lede={t('Turn your text into a PDF or Word file in this room.')} onClose={()=>setOpen(false)} className="hx-document-dialog" footer={<>{active?<button className="dlg-btn" disabled={busy} onClick={()=>void cancel()}>{t('Cancel conversion')}</button>:job?.status==='succeeded'&&job.fileId?<button className="dlg-btn primary" onClick={()=>{onOpen(job.fileId!);setOpen(false)}}>{t('Open file')}</button>:<button className="dlg-btn primary" disabled={busy||!node||!text.trim()||!name.trim()} onClick={()=>void submit()}>{t(busy?'Creating…':'Create document')}</button>}</>}>
  {!job&&<div className="hx-document-form"><label>{t('File name')}<input value={name} maxLength={200} placeholder={t('Report')} onChange={e=>setName(e.target.value)} disabled={busy}/></label><div className="hx-document-formats"><label>{t('Source format')}<select value={inputFormat} disabled={busy} onChange={e=>setInputFormat(e.target.value as 'markdown'|'html')}><option value="markdown">Markdown</option><option value="html">HTML</option></select></label><label>{t('Output format')}<select value={format} disabled={busy} onChange={e=>setFormat(e.target.value as 'pdf'|'docx')}><option value="pdf">PDF</option><option value="docx">Word (.docx)</option></select></label></div><label>{t('Document text')}<textarea value={text} disabled={busy} rows={10} onChange={e=>setText(e.target.value)}/></label><label>{t('Execution node')}<select value={node} disabled={busy||!nodes?.length} onChange={e=>setNode(e.target.value)}>{!nodes?.length&&<option value="">{t(nodes===null?'Loading…':'No document node available')}</option>}{nodes?.map(n=><option value={n.id} key={n.id}>{n.name}</option>)}</select></label>{nodes?.length===0&&!error&&<p>{t('Connect a node with document conversion enabled, then retry.')} <button className="dlg-btn" onClick={()=>setAttempt(v=>v+1)}>{t('Try again')}</button></p>}</div>}
  {job&&<div className="hx-document-status" role="status"><Icon name="file" size={28}/><strong>{job.path||t('Restoring conversion…')}</strong><p>{t(job.status==='queued'?'Waiting for the node…':job.status==='running'?'Converting document…':job.status==='succeeded'?'Document saved':job.status==='cancelled'?'Conversion cancelled':'Document conversion failed')}</p>{!active&&<button className="dlg-btn" onClick={()=>{setJob(null);request.current=null;setError('')}}>{t('Create another document')}</button>}</div>}
  {error&&<div role="alert"><p>{t(error)}</p><button className="dlg-btn" onClick={()=>setAttempt(v=>v+1)}>{t('Try again')}</button></div>}
 </Dialog>}</>
}
