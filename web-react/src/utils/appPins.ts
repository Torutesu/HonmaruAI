import { useCallback, useEffect, useRef, useState } from 'react'
const EVENT = 'honmaru:app-pins'
export function readAppPins(orgId: string): string[] {
  try { const value = JSON.parse(localStorage.getItem(`hx.appPins:${orgId}`) || '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)).slice(0, 8) : [] } catch { return [] }
}
// Server state is scoped to the authenticated user and workspace, never a shared local cache.
export function useAppPins(orgId: string, api: Pick<import('./harness').HarnessApi, 'appPins' | 'setAppPin'>) {
  const [pins, setPins] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [loadedApi,setLoadedApi] = useState<typeof api | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    let live=true, sequence=0
    setPins([]); setPending(false); setLoaded(false); setError(''); generation.current++
    const refresh=async () => {
      if(document.visibilityState==='hidden') return
      const request=++sequence
      try { const result=await api.appPins(); if(live && request===sequence) { setPins(result.pins);setLoadedApi(api);setLoaded(true);setError('') } }
      catch { if(live && request===sequence) setError('固定状態を同期できません。接続を確認してください。') }
    }
    void refresh()
    const timer=window.setInterval(refresh,30000)
    window.addEventListener(EVENT,refresh);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh)
    return () => {live=false;generation.current++;window.clearInterval(timer);window.removeEventListener(EVENT,refresh);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)}
  },[orgId,api])
  const toggle=useCallback(async(id:string)=>{
    if(!loaded || loadedApi!==api || pending) throw new Error('固定状態を同期中です。しばらく待って再試行してください。')
    const active=generation.current
    setPending(true)
    try { await api.setAppPin(id,!pins.includes(id)); if(active===generation.current) { setError('');window.dispatchEvent(new Event(EVENT)) } }
    catch(e) { if(active===generation.current) setError('固定状態を保存できませんでした。');throw e }
    finally { if(active===generation.current) setPending(false) }
  },[api,pins,loaded,loadedApi,pending])
  return {pins:loadedApi===api?pins:[],toggle,pending,error,loaded:loaded&&loadedApi===api}
}
