import {useCallback,useEffect,useRef,useState} from 'react'
import type {WorkspaceFile,WorkspaceFileApi} from './workspaceFiles'

const EVENT='honmaru:workspace-file-pins'
export function useWorkspaceFilePins(orgId:string,api:Pick<WorkspaceFileApi,'filePins'|'setFilePin'>){
 const empty=useRef<WorkspaceFile[]>([]),[pins,setPins]=useState<WorkspaceFile[]>([]),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const [loadedApi,setLoadedApi]=useState<typeof api|null>(null),[loadedOrg,setLoadedOrg]=useState<string|null>(null)
 const generation=useRef(0)
 useEffect(()=>{
  let live=true,sequence=0;setPins([]);setLoaded(false);setLoadedApi(null);setLoadedOrg(null);setBusy(false);setError('');generation.current++
  const refresh=async()=>{if(typeof document!=='undefined'&&document.visibilityState==='hidden')return;const request=++sequence;try{const result=await api.filePins();if(live&&request===sequence){setPins(result.pins);setLoadedApi(api);setLoadedOrg(orgId);setLoaded(true);setError('')}}catch{if(live&&request===sequence)setError('固定したファイルを同期できません。接続を確認してください。')}}
  void refresh();const timer=globalThis.setInterval(refresh,30000);if(typeof window!=='undefined'&&typeof window.addEventListener==='function'){window.addEventListener(EVENT,refresh);window.addEventListener('focus',refresh)}if(typeof document!=='undefined'&&typeof document.addEventListener==='function')document.addEventListener('visibilitychange',refresh)
  return()=>{live=false;generation.current++;globalThis.clearInterval(timer);if(typeof window!=='undefined'&&typeof window.removeEventListener==='function'){window.removeEventListener(EVENT,refresh);window.removeEventListener('focus',refresh)}if(typeof document!=='undefined'&&typeof document.removeEventListener==='function')document.removeEventListener('visibilitychange',refresh)}
 },[orgId,api])
 const toggle=useCallback(async(file:WorkspaceFile)=>{
  if(!loaded||loadedApi!==api||loadedOrg!==orgId||busy)throw new Error('固定状態を同期中です。しばらく待って再試行してください。')
  const active=generation.current;setBusy(true)
  try{const result=await api.setFilePin(file.id,!pins.some(pin=>pin.id===file.id));if(active===generation.current){setPins(result.pins);setError('');if(typeof window!=='undefined'&&typeof window.dispatchEvent==='function')window.dispatchEvent(new Event(EVENT))}}
  catch(e){if(active===generation.current)setError('ファイルの固定を保存できませんでした。');throw e}
  finally{if(active===generation.current)setBusy(false)}
 },[api,busy,loaded,loadedApi,loadedOrg,orgId,pins])
 const current=loaded&&loadedApi===api&&loadedOrg===orgId
 return {pins:current?pins:empty.current,loaded:current,busy:current&&busy,error,toggle}
}
