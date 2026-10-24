import React, {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {FloatingAppContext} from './FloatingAppContext'
import {AppView} from '../screens/Harness'
import {harnessApi,type HarnessApi} from '../utils/harness'
import {hashForApp,type AppSection} from '../utils/route'
import {fitFloatingRect,initialFloatingRect,type FloatingRect} from '../utils/floatingApp'

type Pane={appId:string;section:AppSection;rect:FloatingRect;owner:HarnessApi}
export function FloatingAppWorkspace({children,httpBase,orgId,sessionToken,enabled,interactive=true}:{children:React.ReactNode;httpBase:string;orgId:string;sessionToken:string;enabled:boolean;interactive?:boolean}) {
 const [pane,setPane]=useState<Pane|null>(null)
 const api=useMemo(()=>harnessApi(httpBase,orgId,sessionToken),[httpBase,orgId,sessionToken])
 useEffect(()=>{setPane(null)},[api,enabled])
 const root=useRef<HTMLDivElement|null>(null)
 const interactionRoot=useCallback((node:HTMLDivElement|null)=>{root.current=node;node?.toggleAttribute('inert',!interactive)},[interactive])
 const drag=useRef<{id:number;x:number;y:number;rect:FloatingRect;resize:boolean}|null>(null)
 const open=useCallback((appId:string,section:AppSection)=>{
  if(!/^[\w-]{1,80}$/.test(appId))return
  setPane({appId,section,owner:api,rect:initialFloatingRect(innerWidth,innerHeight)})
 },[api])
 useEffect(()=>{const resize=()=>setPane(p=>p?{...p,rect:fitFloatingRect(p.rect,{width:innerWidth,height:innerHeight})}:p);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize)},[])
 useEffect(()=>{if(pane)root.current?.focus()},[pane?.appId])
 const move=(rect:FloatingRect)=>setPane(p=>p?{...p,rect:fitFloatingRect(rect,{width:innerWidth,height:innerHeight})}:p)
 const start=(event:React.PointerEvent<HTMLDivElement>)=>{
  if(!pane||event.button!==0)return
  const target=event.target as HTMLElement,resize=Boolean(target.closest('.hx-floating-resize'))
  if(!resize&&(!target.closest('.screen-head')||target.closest('button,a,input,select,textarea')))return
  event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId)
  drag.current={id:event.pointerId,x:event.clientX,y:event.clientY,rect:pane.rect,resize}
 }
 const finish=(event:React.PointerEvent<HTMLDivElement>)=>{if(drag.current?.id===event.pointerId){drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)}}
 return <FloatingAppContext.Provider value={enabled?open:null}>
  {children}
  {enabled&&pane&&pane.owner===api&&<div ref={interactionRoot} className="hx-floating-app" role="region" aria-label="フローティングアプリ" aria-description="矢印キーで移動、Shiftと矢印キーでサイズ変更" tabIndex={0} style={{left:pane.rect.x,top:pane.rect.y,width:pane.rect.width,height:pane.rect.height}}
   onPointerDown={start} onPointerMove={event=>{const d=drag.current;if(!d||d.id!==event.pointerId)return;const dx=event.clientX-d.x,dy=event.clientY-d.y;move(d.resize?{...d.rect,width:d.rect.width+dx,height:d.rect.height+dy}:{...d.rect,x:d.rect.x+dx,y:d.rect.y+dy})}} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={()=>{drag.current=null}}
   onKeyDown={event=>{if(event.target!==event.currentTarget||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const dx=event.key==='ArrowLeft'?-16:event.key==='ArrowRight'?16:0,dy=event.key==='ArrowUp'?-16:event.key==='ArrowDown'?16:0;move(event.shiftKey?{...pane.rect,width:pane.rect.width+dx,height:pane.rect.height+dy}:{...pane.rect,x:pane.rect.x+dx,y:pane.rect.y+dy})}}>
    <AppView key={pane.appId} api={api} appId={pane.appId} httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} initialSection={pane.section} onSectionChange={section=>setPane(p=>p?{...p,section}:p)} floating onClose={()=>setPane(null)} onBack={()=>{location.hash=hashForApp(pane.appId,orgId,undefined,pane.section);setPane(null)}} />
    <div className="hx-floating-resize" aria-hidden="true" />
  </div>}
 </FloatingAppContext.Provider>
}
