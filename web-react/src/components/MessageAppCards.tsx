import React, {useEffect,useRef,useState} from 'react'
import {appLinksIn} from '../utils/appLinks'
import {useAppPins} from '../utils/appPins'
import {hashForApp} from '../utils/route'
import type {HarnessApi} from '../utils/harness'
import {HarnessAppIcon} from './HarnessAppIcon'
import {HarnessAppPreviewContent} from './HarnessAppPreview'
import {Icon} from './Icon'

type Snapshot=Awaited<ReturnType<HarnessApi['app']>>
export function MessageAppCards({text,api,onOpen}:{text:string;api:HarnessApi;onOpen?:(id:string)=>void}) {
 const links=appLinksIn(text,api.orgId)
 return links.length?<div className="hx-message-app-cards">{links.map(link=><MessageAppCard key={`${api.orgId}:${link.id}`} id={link.id} api={api} onOpen={onOpen}/>)}</div>:null
}
function MessageAppCard({id,api,onOpen}:{id:string;api:HarnessApi;onOpen?:(id:string)=>void}) {
 const host=useRef<HTMLDivElement>(null),[visible,setVisible]=useState(false),[attempt,setAttempt]=useState(0)
 const [data,setData]=useState<Snapshot|null>(null),[loadedApi,setLoadedApi]=useState<HarnessApi|null>(null),[error,setError]=useState(false)
 useEffect(()=>{if(!host.current)return;if(typeof IntersectionObserver==='undefined'){setVisible(true);return}const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting),{rootMargin:'80px'});observer.observe(host.current);return()=>observer.disconnect()},[])
 useEffect(()=>{let live=true;setData(null);setLoadedApi(null);setError(false);if(visible)void api.app(id).then(result=>{if(live){if(result.app.id!==id){setError(true);return}setData(result);setLoadedApi(api)}},()=>{if(live)setError(true)});return()=>{live=false}},[api,id,visible,attempt])
 return <div ref={host} className="hx-message-app-card">{data&&loadedApi===api?<LoadedCard data={data} api={api} onOpen={onOpen}/>:<div className="hx-message-app-state" role="status"><Icon name="grid" size={18}/><span>{error?'このアプリを表示できません':'アプリを読み込んでいます…'}</span>{error&&<button type="button" onClick={()=>setAttempt(n=>n+1)}>再読み込み</button>}</div>}</div>
}
function LoadedCard({data,api,onOpen}:{data:Snapshot;api:HarnessApi;onOpen?:(id:string)=>void}) {
 const {pins,toggle,pending,loaded,error}=useAppPins(api.orgId,api)
 const app=data.app,pinned=pins.includes(app.id)
 return <div className="hx-message-app-tile">
  <button type="button" className="hx-app-card-open" aria-label={`${app.name}を開く`} onClick={()=>onOpen?onOpen(app.id):location.hash=hashForApp(app.id,api.orgId,{})}/>
  <span className="hx-message-app-heading"><HarnessAppIcon icon={app.icon} size={16}/><strong>{app.name}</strong><span className="hx-message-app-tag">アプリ</span></span>
  <button type="button" className={`hx-app-card-pin ${pinned?'on':''}`} disabled={!loaded||pending} aria-label={pinned?`${app.name}の固定を解除`:`${app.name}をナビゲーションに固定`} aria-pressed={pinned} onClick={()=>void toggle(app.id).catch(()=>{})}><Icon name="pin" size={14}/></button>
  <span className="hx-app-live-preview" aria-hidden="true"><span className="hx-preview-viewport"><HarnessAppPreviewContent data={data} httpBase={api.httpBase}/></span></span>
  {error&&<span className="hx-message-app-error" role="status">{error}</span>}
 </div>
}
