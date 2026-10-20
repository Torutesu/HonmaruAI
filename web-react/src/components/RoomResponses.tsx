import React, { useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { useWorkspaceMode } from '../utils/harness'

interface Props { httpBase: string; orgId: string; headers: Record<string, string>; view: string }
export function RoomResponses(props: Props) {
  const token = props.headers['x-session-token'] || ''
  const { mode } = useWorkspaceMode(props.httpBase, props.orgId, token)
  return mode === 'harness' && props.view.startsWith('b:') ? <ResponseSetting key={`${props.httpBase}:${props.orgId}:${props.view}:${token}`} {...props}/> : null
}
function ResponseSetting({ httpBase, orgId, headers, view }: Props) {
  const t = useT()
  const [saved, setSaved] = useState<{ mentionedOnly: boolean; version: number } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [canEdit, setCanEdit] = useState(false), [conflict, setConflict] = useState(false)
  const [revision, reload] = useState(0)
  const pending = useRef(false), alive = useRef(true)
  const token = headers['x-session-token'] || ''
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setSaved(null); setError(''); setCanEdit(false); setConflict(false)
    fetch(`${httpBase}/hx/rooms/responses?${new URLSearchParams({ orgId, channel: view })}`, { headers: { 'x-session-token': token }, signal: controller.signal })
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.message); return d })
      .then(d => { if (!controller.signal.aborted) { setSaved(d.responses); setCanEdit(d.canEdit === true) } })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [httpBase, orgId, token, view, revision])
  const save = async (mentionedOnly: boolean) => {
    if (!saved || !canEdit || conflict || pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const r = await fetch(`${httpBase}/hx/rooms/responses`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-session-token': token }, body: JSON.stringify({ orgId, channel: view, mentionedOnly, version: saved.version }) })
      const d = await r.json()
      if (!r.ok) { if (r.status === 409 && alive.current) setConflict(true); throw new Error(d.message) }
      if (alive.current) setSaved(d.responses)
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="slk-describe" aria-label={t('How agents respond')}>
    <h3>{t('How agents respond')}</h3>
    {!saved && !error && <p role="status">{t('Loading…')}</p>}
    <label className="dlg-check"><input type="checkbox" role="switch" disabled={!saved || !canEdit || busy || conflict} checked={saved?.mentionedOnly || false} onChange={e => void save(e.target.checked)}/>{t('Mentioned only')}</label>
    <p className="hx-hint">{t('When enabled, unmentioned room messages do not continue an agent response. Direct messages are unchanged.')}</p>
    {busy && <p role="status">{t('Saving…')}</p>}
    {error && <div role="alert" className="form-error">{t(error)} <button disabled={busy} onClick={() => reload(n => n + 1)}>{t('Reload')}</button></div>}
  </section>
}
