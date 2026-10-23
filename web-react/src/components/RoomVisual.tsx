import React,{useEffect,useState} from 'react'
type Api={httpBase:string;orgId:string;sessionToken:string}
export function RoomVisual({api,channel,version,fallback}:{api:Api;channel:string;version?:number;fallback:React.ReactNode}){
 const scope=JSON.stringify([api.httpBase,api.orgId,api.sessionToken,channel,version])
 const [image,setImage]=useState<{scope:string;url:string}|null>(null)
 useEffect(()=>{
  if(!version)return
  let active=true,url:string|undefined
  const controller=new AbortController()
  const timer=setTimeout(()=>{active=false;controller.abort()},15000)
  void (async()=>{
   try{
    const response=await fetch(`${api.httpBase}/hx/rooms/visual?${new URLSearchParams({orgId:api.orgId,channel,version:String(version)})}`,{headers:{'x-session-token':api.sessionToken},signal:controller.signal,cache:'no-store'})
    if(!response.ok)return
    const blob=await response.blob()
    if(!active||!['image/png','image/jpeg','image/webp','image/gif'].includes(blob.type))return
    url=URL.createObjectURL(blob);setImage({scope,url})
   }catch{}finally{clearTimeout(timer)}
  })()
  return()=>{active=false;clearTimeout(timer);controller.abort();if(url)URL.revokeObjectURL(url)}
 },[scope])
 return image?.scope===scope?<img src={image.url} alt="" className="room-visual" onError={()=>setImage(null)}/>:<>{fallback}</>
}
