import React,{lazy,Suspense,useEffect,useState} from 'react'
import {Icon} from './Icon'
import {Dialog} from './Dialog'
import {DocumentCreate} from './DocumentCreate'
import {useT} from '../utils/i18n'
import {workspaceFilePreviewKind} from '../utils/workspaceFilePreview'
import type {WorkspaceFileApi,WorkspaceFile,FileVersion} from '../utils/workspaceFiles'
import './DocumentPreview.css'
const Content=lazy(()=>import('./DocumentPreview').then(module=>({default:module.DocumentContent})))
export function WorkspaceFilePreview({api,file,version,onClose,onShare,onOpenFile,inline=false}:{api:WorkspaceFileApi;file:WorkspaceFile;version:FileVersion;inline?:boolean;onClose:()=>void;onShare?:()=>void;onOpenFile?:(id:string)=>void}){
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
 const filename=file.path.split('/').at(-1)||file.path
 const format:'html'|'markdown'|null=/\.html?$/i.test(filename)?'html':/\.md$/i.test(filename)?'markdown':null
 const source=bytes&&format&&bytes.length<=2*1024*1024?{text:new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/,''),name:filename.replace(/\.(html?|md)$/i,''),format}:undefined
 const directory=file.path.includes('/')?file.path.slice(0,file.path.lastIndexOf('/')+1):''
 const exportControl=source&&<DocumentCreate key={`export:${file.id}:${version.version}`} api={api} scope={file.scope} directory={directory} source={source} onOpen={id=>onOpenFile?.(id)}/>
 const actions=<>{exportControl}{onShare&&<button type="button" onClick={onShare}><Icon name="share" size={15}/>{t('Share')}</button>}</>
 return inline?<section className="document-preview hx-inline-file-preview" aria-label={`${file.path} · v${version.version}`}><header><strong>{filename} · v${version.version}</strong>{onShare&&<button type="button" onClick={onShare} aria-label={t('Share')} title={t('Share')}><Icon name="share" size={15}/></button>}<button type="button" onClick={onClose} aria-label={t('Close preview')}><Icon name="x" size={16}/></button></header>{content}{exportControl}</section>:<Dialog title={`${file.path} · v${version.version}`} className="document-preview" onClose={onClose} footer={actions}>{content}</Dialog>
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
