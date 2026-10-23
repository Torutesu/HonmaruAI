import {RoomGuidelinesDialog} from './RoomGuidelinesDialog'
import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { useWorkspaceMode } from '../utils/harness'

interface Guidelines { body: string; version: number }
function LegacyRoomGuidelines({ httpBase, orgId, headers, view }: {
  httpBase: string; orgId: string; headers: Record<string, string>; view: string
}) {
  const t = useT()
  const { mode } = useWorkspaceMode(httpBase, orgId, headers['x-session-token'] || '')
  const [saved, setSaved] = useState<Guidelines | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, reload] = useState(0)
  const token = headers['x-session-token'] || ''
  useEffect(() => {
    setSaved(null); setDraft(''); setError('')
    if (mode !== 'harness' || !view.startsWith('b:')) return
    const controller = new AbortController()
    const q = new URLSearchParams({ orgId, channel: view })
    fetch(`${httpBase}/hx/rooms/guidelines?${q}`, { headers: { 'x-session-token': token }, signal: controller.signal })
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.message); return d })
      .then(d => { if (!controller.signal.aborted) { setSaved(d.guidelines); setDraft(d.guidelines.body) } })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [httpBase, orgId, token, view, mode, revision])
  if (mode !== 'harness' || !view.startsWith('b:')) return null
  const save = async () => {
    if (!saved) return
    setBusy(true); setError('')
    try {
      const r = await fetch(`${httpBase}/hx/rooms/guidelines`, {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId, channel: view, body: draft, version: saved.version }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.message)
      setSaved(d.guidelines); setDraft(d.guidelines.body)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <section className="slk-describe" aria-label={t('Room guidelines')}>
    <h3>{t('Room guidelines')}</h3>
    <p className="hx-hint">{t('Room rules for built-in agents, workflow agent steps and follow-ups.')}</p>
    {saved && <>
      <textarea className="cl-input" rows={4} maxLength={4096} value={draft} disabled={busy}
        aria-label={t('Room guidelines')} onChange={e => setDraft(e.target.value)} />
      <div className="slk-describe-bar">
        <span>{draft.length} / 4096</span>
        <button type="button" className="slk-send" disabled={busy || draft === saved.body} onClick={() => void save()}>{t(busy ? 'Saving…' : 'Save')}</button>
      </div>
    </>}
    {error && <div role="alert" className="form-error">{error} <button type="button" disabled={busy} onClick={() => reload(n => n + 1)}>{t('Reload')}</button></div>}
  </section>
}


// Managed rooms share the same dialog from both the header menu and details.
// Keep the existing inline controls for legacy rooms and Simple-mode behavior.
export function RoomGuidelines(props:{httpBase:string;orgId:string;headers:Record<string,string>;view:string;managed?:boolean}){
 return props.managed?<ManagedGuidelinesEntry {...props}/>:<LegacyRoomGuidelines {...props}/>
}
function ManagedGuidelinesEntry({httpBase,orgId,headers,view}:{httpBase:string;orgId:string;headers:Record<string,string>;view:string}){
 const [open,setOpen]=useState(false),t=useT()
 const token=headers['x-session-token']||''
 const {mode}=useWorkspaceMode(httpBase,orgId,token)
 if(mode!=='harness')return null
 return <section className="slk-describe" aria-label={t('Room guidelines')}>
  <h3>{t('Room guidelines')}</h3>
  <button type="button" className="dlg-btn" onClick={()=>setOpen(true)}>ガイドラインを開く</button>
  {open&&<RoomGuidelinesDialog key={`${httpBase}:${orgId}:${token}:${view}`} api={{httpBase,orgId,sessionToken:token}} channel={view} onClose={()=>setOpen(false)}/>}
 </section>
}
