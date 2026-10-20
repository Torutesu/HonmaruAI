import {useEffect,useRef,useState} from 'react'
type Api={httpBase:string;orgId:string;sessionToken:string}
export function useThreadNotifications(api:Api,channel:string,messageId:string,open:boolean){
 const scope=`${api.httpBase}:${api.orgId}:${api.sessionToken}:${channel}:${messageId}`
 const current=useRef(scope);current.current=scope
 const live=useRef(true),writing=useRef<string|null>(null)
 const [state,setState]=useState<{scope:string;muted:boolean|null;busy:boolean;error:string}>({scope,muted:null,busy:false,error:''})
 useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 useEffect(()=>{
  if(!open||writing.current===scope)return
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000)
  let active=true
  setState({scope,muted:null,busy:false,error:''})
  void fetch(`${api.httpBase}/channels/thread/notifications?${new URLSearchParams({orgId:api.orgId,channel,messageId})}`,{headers:{'x-session-token':api.sessionToken},signal:controller.signal})
   .then(async response=>{const value=await response.json();if(!response.ok||typeof value.muted!=='boolean')throw new Error();if(active&&live.current&&current.current===scope)setState({scope,muted:value.muted,busy:false,error:''})})
   .catch(()=>{if(active&&live.current&&current.current===scope)setState({scope,muted:null,busy:false,error:'通知設定を読み込めませんでした。メニューを開き直して再試行してください。'})})
   .finally(()=>clearTimeout(timer))
  return()=>{active=false;clearTimeout(timer);controller.abort()}
 },[scope,open])
 const toggle=async()=>{
  if(writing.current===scope||state.scope!==scope||state.muted===null)return
  const muted=!state.muted
  writing.current=scope;setState({...state,busy:true,error:''})
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000)
  try{
   const response=await fetch(`${api.httpBase}/channels/thread/notifications`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':api.sessionToken},signal:controller.signal,body:JSON.stringify({orgId:api.orgId,channel,messageId,muted})})
   const value=await response.json()
   if(!response.ok||typeof value.muted!=='boolean')throw new Error()
   if(live.current&&current.current===scope)setState({scope,muted:value.muted,busy:false,error:''})
  }catch{
   if(live.current&&current.current===scope)setState({scope,muted:null,busy:false,error:'通知設定を保存できませんでした。メニューを開き直して現在の設定を確認してください。'})
  }finally{clearTimeout(timer);if(writing.current===scope)writing.current=null}
 }
 return {...(state.scope===scope?state:{muted:null,busy:false,error:''}),toggle}
}
