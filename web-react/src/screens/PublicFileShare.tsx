import React,{useEffect,useState} from 'react'
import './SharedThread.css'

type SharedFile={name:string;version:number;contentType:string;size:number}
type SharedFileSet={name:string;version:number;files:SharedFile[];allowDownload:boolean;expiresAt:string|null}
type State='loading'|'ready'|'missing'|'error'

export function PublicFileShare({httpBase,token}:{httpBase:string;token:string}){
 const [share,setShare]=useState<SharedFileSet|null>(null),[state,setState]=useState<State>('loading'),[attempt,setAttempt]=useState(0),[previews,setPreviews]=useState<Record<number,string>>({})
 useEffect(()=>{const robots=document.createElement('meta');robots.name='robots';robots.content='noindex,nofollow,noarchive';document.head.appendChild(robots);return()=>robots.remove()},[])
 useEffect(()=>{const controller=new AbortController();let live=true;setShare(null);setState('loading');setPreviews({})
  void fetch(`${httpBase}/workspace-file-shares/${encodeURIComponent(token)}`,{credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal})
   .then(async response=>{if(response.status===404){if(live)setState('missing');return null}if(!response.ok)throw new Error('share');return response.json()})
   .then(value=>{if(!live||!value)return;const item=value.share
    if(typeof item?.name!=='string'||!Number.isSafeInteger(item.version)||!Array.isArray(item.files)||item.files.length<1||typeof item.allowDownload!=='boolean')throw new Error('shape')
    if(item.files.some((file:SharedFile)=>typeof file?.name!=='string'||!Number.isSafeInteger(file.version)||!Number.isSafeInteger(file.size)||typeof file.contentType!=='string'))throw new Error('shape')
    setShare(item);setState('ready')
   }).catch(()=>{if(live&&!controller.signal.aborted)setState('error')})
  return()=>{live=false;controller.abort()}
 },[httpBase,token,attempt])
 useEffect(()=>{if(!share||share.allowDownload)return;const controller=new AbortController();let live=true
  for(const [index,file] of share.files.entries())if(file.contentType.toLowerCase().startsWith('text/plain'))void fetch(`${httpBase}/workspace-file-shares/${encodeURIComponent(token)}/content/preview?index=${index}`,{credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal})
   .then(response=>response.ok?response.text():null).then(text=>{if(live&&text!==null)setPreviews(prev=>({...prev,[index]:text}))}).catch(()=>{})
  return()=>{live=false;controller.abort()}
 },[httpBase,token,share])
 const content=(index:number)=>`${httpBase}/workspace-file-shares/${encodeURIComponent(token)}/content/${index}`
 return <main className="shared-thread public-file-share"><header><a href="#/">Honmaru</a><span>共有されたファイル</span></header>
  {state==='loading'&&<p role="status">共有ファイルを読み込んでいます…</p>}
  {state==='missing'&&<section><h1>この共有リンクは利用できません</h1><p>期限切れ、無効化、または存在しないリンクです。</p></section>}
  {state==='error'&&<section role="alert"><h1>共有ファイルを読み込めませんでした</h1><button className="pill-btn" onClick={()=>setAttempt(value=>value+1)}>再試行</button></section>}
  {state==='ready'&&share&&<section className="public-skill-share-card"><p className="shared-thread-note">承認されたファイルスナップショットです。</p><h1>{share.name}</h1><p className="shared-thread-note">版 v{share.version}{share.expiresAt?` · 有効期限 ${new Date(share.expiresAt).toLocaleString()}`:''}</p>
   <ul className="public-file-share-list">{share.files.map((file,index)=>{const type=file.contentType.split(';')[0].toLowerCase();const src=content(index);return <li key={`${file.name}:${file.version}`}><div><b>{file.name}</b><small>v{file.version} · {file.size.toLocaleString()} bytes</small></div>
    {!share.allowDownload&&type.startsWith('image/')&&<img src={src} alt={file.name} referrerPolicy="no-referrer"/>}
    {!share.allowDownload&&type.startsWith('video/')&&<video src={src} controls playsInline/>}
    {!share.allowDownload&&type.startsWith('audio/')&&<audio src={src} controls preload="none"/>}
    {!share.allowDownload&&type==='text/plain'&&<pre>{previews[index]??'プレビューを読み込んでいます…'}</pre>}
    {share.allowDownload&&<a className="pill-btn quiet" href={src} referrerPolicy="no-referrer">ダウンロード</a>}
   </li>})}</ul>
  </section>}
 </main>
}
