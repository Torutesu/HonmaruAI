import React,{lazy,Suspense,useEffect,useState} from 'react'
import {Icon} from './Icon'
import {Dialog} from './Dialog'
import {useT} from '../utils/i18n'
import {workspaceFilePreviewKind} from '../utils/workspaceFilePreview'
import type {WorkspaceFileApi,WorkspaceFile,FileVersion} from '../utils/workspaceFiles'
import './DocumentPreview.css'
const Content=lazy(()=>import('./DocumentPreview').then(module=>({default:module.DocumentContent})))
export function WorkspaceFilePreview({api,file,version,onClose,inline=false}:{api:WorkspaceFileApi;file:WorkspaceFile;version:FileVersion;inline?:boolean;onClose:()=>void}){
 const t=useT(),kind=workspaceFilePreviewKind(version.contentType||'',file.path),[bytes,setBytes]=useState<Uint8Array|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0)
 useEffect(()=>{let live=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);setBytes(null);setError('')
  const load=async()=>{const limit=kind==='pdf'||kind==='image'?25*1024*1024:2*1024*1024
   if(!kind)throw new Error(t('Preview is not available for this file type.'))
   if((version.size??0)>limit)throw new Error(t('This file is too large to preview. Download it instead.'))
   const blob=await api.download(file.id,version.version,controller.signal)
   if(blob.size>limit)throw new Error(t('This file is too large to preview. Download it instead.'))
   const data=new Uint8Array(await blob.arrayBuffer());if(live&&!controller.signal.aborted)setBytes(data)
  }
  void load().catch(reason=>{if(live)setError(controller.signal.aborted?t('Preview timed out. Try again.'):String(reason.message||reason))}).finally(()=>clearTimeout(timer))
  return()=>{live=false;controller.abort();clearTimeout(timer)}
 },[api,file.id,version.version,version.size,kind,attempt,t])
 const fallback=<div role="alert"><p>{t('Preview could not be displayed.')}</p><button onClick={()=>setAttempt(value=>value+1)}>{t('Retry')}</button></div>
 const content=error?<div role="alert"><p>{error}</p><button onClick={()=>setAttempt(value=>value+1)}>{t('Retry')}</button></div>:bytes&&kind?<PreviewBoundary key={attempt} fallback={fallback}>{kind==='image'?<RasterPreview bytes={bytes} type={version.contentType||''} name={file.path} onError={()=>setError(t('Preview could not be displayed.'))}/>:<Suspense fallback={<p role="status">{t('Loading…')}</p>}><Content bytes={bytes} kind={kind} fit={inline}/></Suspense>}</PreviewBoundary>:<p role="status">{t('Loading…')}</p>
 return inline?<section className="document-preview hx-inline-file-preview" aria-label={`${file.path} · v${version.version}`}><header><strong>{file.path.split('/').at(-1)} · v{version.version}</strong><button type="button" onClick={onClose} aria-label={t('Close preview')}><Icon name="x" size={16}/></button></header>{content}</section>:<Dialog title={`${file.path} · v${version.version}`} className="document-preview" onClose={onClose}>{content}</Dialog>
}

class PreviewBoundary extends React.Component<React.PropsWithChildren<{fallback:React.ReactNode}>,{failed:boolean}>{
 state={failed:false}
 static getDerivedStateFromError(){return {failed:true}}
 render(){return this.state.failed?this.props.fallback:this.props.children}
}
function RasterPreview({bytes,type,name,onError}:{bytes:Uint8Array;type:string;name:string;onError:()=>void}){
 const [url,setUrl]=useState('')
 useEffect(()=>{const value=URL.createObjectURL(new Blob([bytes as BlobPart],{type}));setUrl(value);return()=>URL.revokeObjectURL(value)},[bytes,type])
 return url?<img src={url} alt={name} onError={onError} style={{maxWidth:'100%',maxHeight:'70vh',objectFit:'contain',display:'block',margin:'auto'}}/>:null
}
