import {useT} from '../utils/i18n'
import React,{useEffect,useRef,useState} from 'react'
import {RoomColorPicker} from './RoomColorPicker'
import {RoomVisual} from './RoomVisual'
import {Icon} from './Icon'
import {ROOM_COLORS} from '../utils/roomColors'
type Api={httpBase:string;orgId:string;sessionToken:string}
export function RoomVisualEditor({api,channel,version,visualVersion,color,onColor,disabled,dirty,onChanged,onBusy}:{api:Api;channel:string;version:number;visualVersion?:number;color:keyof typeof ROOM_COLORS;onColor:(color:keyof typeof ROOM_COLORS)=>void;disabled:boolean;dirty:boolean;onChanged:()=>void;onBusy:(busy:boolean)=>void}){
 const t=useT()
 const generation=useRef(0),request=useRef<AbortController|null>(null)
 useEffect(()=>{generation.current++;return()=>{generation.current++;request.current?.abort();onBusy(false)}},[])
 const file=useRef<HTMLInputElement>(null),pending=useRef(false)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false)
 const save=async(image:File|null)=>{
  if(disabled||dirty||pending.current||uncertain)return
  if(image&&(!['image/png','image/jpeg','image/webp','image/gif'].includes(image.type)||image.size>2*1024*1024)){setError('Choose a PNG, JPEG, WebP or GIF up to 2 MB.');return}
  const scope=generation.current
  pending.current=true;setBusy(true);onBusy(true);setError('')
  const controller=new AbortController();request.current=controller;let timer:ReturnType<typeof setTimeout>|undefined
  try{
   const response=await Promise.race([fetch(`${api.httpBase}/hx/rooms/visual?${new URLSearchParams({orgId:api.orgId,channel,version:String(version)})}`,{method:image?'POST':'DELETE',headers:{'x-session-token':api.sessionToken,...(image?{'content-type':image.type}:{})},...(image?{body:image}:{}),signal:controller.signal}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(Error('timeout'));controller.abort()},15000)})])
   if(scope!==generation.current)return
   if(!response.ok){setUncertain(true);setError('The visual could not be changed. Reload the latest settings to check.');return}
   onChanged()
  }catch{if(scope===generation.current){setUncertain(true);setError('The save result could not be confirmed. Reload the latest settings to check.')}}
  finally{clearTimeout(timer);if(scope===generation.current){request.current=null;pending.current=false;setBusy(false);onBusy(false)}}
 }
 return <><RoomColorPicker color={color} onChange={onColor} disabled={disabled||busy} visualDisabled={dirty||uncertain}
  visual={visualVersion?<RoomVisual api={api} channel={channel} version={visualVersion} fallback={<Icon name="room" size={18}/>}/>:undefined}
  onUpload={()=>file.current?.click()} onRemove={visualVersion?()=>void save(null):undefined}/>
  <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" aria-label={t('Room visual')} onChange={event=>{const image=event.target.files?.[0];event.target.value='';if(image)void save(image)}}/>
  {dirty&&<small>{t('Save room settings before changing the visual.')}</small>}
  {busy&&<small role="status">{t('Saving visual…')}</small>}
  {error&&<div role="alert" className="dlg-error">{t(error)} {uncertain&&<button type="button" disabled={busy} onClick={onChanged}>{t('Reload latest settings')}</button>}</div>}
 </>
}
