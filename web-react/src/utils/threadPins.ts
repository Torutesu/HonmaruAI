import {useCallback,useEffect,useRef,useState} from 'react'
export type ThreadPin={id:string;view:string;title:string;createdAt:string}
type Api={httpBase:string;orgId:string;sessionToken:string}
export function useThreadPins(api:Api,enabled:boolean){
 const scope=JSON.stringify([api.httpBase,api.orgId,api.sessionToken]),now=useRef(scope);now.current=scope
 const [state,setState]=useState<{scope:string;pins:ThreadPin[];loaded:boolean;error:string}>({scope,pins:[],loaded:false,error:''})
 const [busy,setBusy]=useState(false),sequence=useRef(0),writing=useRef(false),mounted=useRef(false)
 const refresh=useCallback(async()=>{
  if(!enabled||writing.current||document.visibilityState==='hidden')return
  const request=++sequence.current
  try{
   const response=await fetch(`${api.httpBase}/channels/thread-pins?${new URLSearchParams({orgId:api.orgId})}`,{headers:{'x-session-token':api.sessionToken}})
   if(!response.ok)throw new Error('unavailable')
   const result=await response.json()
   if(mounted.current&&now.current===scope&&request===sequence.current)setState({scope,pins:result.pins,loaded:true,error:''})
  }catch{if(mounted.current&&now.current===scope&&request===sequence.current)setState({scope,pins:[],loaded:false,error:'固定したスレッドを取得できませんでした。'})}
 },[api.httpBase,api.orgId,api.sessionToken,scope,enabled])
 useEffect(()=>{
  mounted.current=true;writing.current=false;setBusy(false);setState({scope,pins:[],loaded:false,error:''})
  if(!enabled)return()=>{mounted.current=false;sequence.current++}
  void refresh()
  const timer=window.setInterval(()=>void refresh(),30000)
  window.addEventListener('focus',refresh);window.addEventListener('honmaru:resync',refresh);document.addEventListener('visibilitychange',refresh)
  return()=>{mounted.current=false;sequence.current++;window.clearInterval(timer);window.removeEventListener('focus',refresh);window.removeEventListener('honmaru:resync',refresh);document.removeEventListener('visibilitychange',refresh)}
 },[scope,enabled,refresh])
 const toggle=useCallback(async(id:string)=>{
  if(!enabled||writing.current||state.scope!==scope||!state.loaded)return
  writing.current=true;setBusy(true);const request=++sequence.current
  try{
   const response=await fetch(`${api.httpBase}/channels/thread-pins`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':api.sessionToken},body:JSON.stringify({orgId:api.orgId,messageId:id,pinned:!state.pins.some(pin=>pin.id===id)})})
   const result=await response.json()
   if(!response.ok)throw new Error(result.message||'固定状態を保存できませんでした。')
   if(mounted.current&&now.current===scope&&request===sequence.current)setState({scope,pins:result.pins,loaded:true,error:''})
  }catch(error){if(mounted.current&&now.current===scope&&request===sequence.current)setState(previous=>({...previous,error:error instanceof Error?error.message:'固定状態を保存できませんでした。'}))}
  finally{if(now.current===scope&&request===sequence.current){writing.current=false;if(mounted.current)setBusy(false)}}
 },[api.httpBase,api.orgId,api.sessionToken,enabled,scope,state])
 return {pins:state.scope===scope?state.pins:[],loaded:state.scope===scope&&state.loaded,error:state.scope===scope?state.error:'',busy,toggle,refresh}
}
