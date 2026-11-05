import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

type Visibility = 'private' | 'workspace' | 'public'
interface Access { visibility: Visibility; internalVisibility?: 'private' | 'workspace'; version: number }
interface Field { id: string; name: string; type?: string }
interface PublicShare { id: string; appVersion: number; dataScope: { entity: string; fields: string[] }[]; url: string | null; createdAt: string }
interface PublicSettings { share: PublicShare | null; entities: { key: string; name: string; fields: Field[] }[]; appVersion: number }
export function AppSharing({ httpBase, orgId, sessionToken, appId }: { httpBase: string; orgId: string; sessionToken: string; appId: string }) {
  const t = useT()
  const [access, setAccess] = useState<Access | null>(null)
  const [choice, setChoice] = useState<Visibility>('workspace')
  const [canEdit, setCanEdit] = useState(false)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const base = `${httpBase}/apps/${appId}`
  const headers = { 'content-type': 'application/json', 'x-session-token': sessionToken }
  const load = async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ orgId })
    const [a, p] = await Promise.all([
      fetch(`${base}/access?${query}`, { headers, signal }),
      fetch(`${base}/public-shares?${query}`, { headers, signal }),
    ])
    const [ad, pd] = await Promise.all([a.json(), p.json()])
    if (!a.ok) throw new Error(ad.message || String(a.status))
    if (!p.ok) throw new Error(pd.message || String(p.status))
    setAccess(ad.access); setChoice(ad.access.visibility); setCanEdit(ad.canEdit); setSettings(pd)
    setSelected(pd.share?.dataScope?.find((x: { entity: string }) => x.entity === 'primary')?.fields || [])
  }
  useEffect(() => {
    const controller = new AbortController()
    setAccess(null); setSettings(null); setCanEdit(false); setError('')
    load(controller.signal).catch(err => { if (!controller.signal.aborted) setError(String(err.message)) })
    return () => controller.abort()
  }, [httpBase, orgId, sessionToken, appId])
  const save = async (visibility: 'private' | 'workspace') => {
    if (!access) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${base}/access`, { method: 'PUT', headers, body: JSON.stringify({ orgId, visibility, version: access.version }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      setAccess(data.access); setChoice(data.access.visibility); setSettings(s => s ? { ...s, share: null } : s)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setChoice(access.visibility) }
    finally { setBusy(false) }
  }
  const publish = async () => {
    if (!settings || !selected.length || !confirmed) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${base}/public-shares`, { method: 'POST', headers, body: JSON.stringify({ orgId, appVersion: settings.appVersion, fields: selected, publicDataConfirmed: true }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      const url = new URL(data.share.url, httpBase).toString()
      setSettings({ ...settings, share: { ...data.share, url } }); setChoice('public'); setConfirmed(false)
      setAccess(a => a ? { ...a, visibility: 'public' } : a)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const revoke = async () => {
    if (!settings?.share) return
    setBusy(true); setError('')
    try {
      const query = new URLSearchParams({ orgId, shareId: settings.share.id })
      const res = await fetch(`${base}/public-shares?${query}`, { method: 'DELETE', headers })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      setSettings({ ...settings, share: null }); setChoice(access?.internalVisibility || 'private')
      setAccess(a => a ? { ...a, visibility: a.internalVisibility || 'private' } : a)
      setSelected([]); setConfirmed(false)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const shareUrl = settings?.share?.url ? new URL(settings.share.url, httpBase).toString() : ''
  return <section>
    <div className="rows-title">{t('Sharing')}</div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {access && <div className="row static"><span className="row-main">
      <select aria-label={t('App visibility')} value={choice} disabled={!canEdit || busy} onChange={e => {
        const value = e.target.value as Visibility; setChoice(value)
        if (value !== 'public') void save(value)
      }}>
        <option value="workspace">{t('Workspace members')}</option><option value="private">{t('Only me')}</option><option value="public">{t('Anyone with the link')}</option>
      </select>
      <span className="row-sub">{t('Room links do not grant access. Public links are read-only and expose only fields you select.')}</span>
    </span></div>}
    {choice === 'public' && settings && <div className="row static"><div className="row-main">
      <strong>{t('Public app link')}</strong>
      <p className="row-sub">{t('This link is pinned to app version')} {settings.share?.appVersion ?? settings.appVersion}. {t('Anyone with the URL can view the published app and selected fields.')}</p>
      {settings.share?.url && <div className="hx-public-link"><input aria-label={t('Public URL')} readOnly value={shareUrl} onFocus={e => e.currentTarget.select()} /><button type="button" disabled={busy} onClick={() => void navigator.clipboard?.writeText(shareUrl)}>{t('Copy link')}</button><button type="button" disabled={busy} onClick={() => void revoke()}>{t('Revoke')}</button></div>}
      {!settings.share && <><div className="hx-public-fields" aria-label={t('Public fields')}>{settings.entities.flatMap(entity => entity.key === 'primary' ? entity.fields.map(field => <label key={field.id}><input type="checkbox" checked={selected.includes(field.id)} disabled={!canEdit || busy} onChange={e => setSelected(v => e.target.checked ? [...v, field.id] : v.filter(x => x !== field.id))} />{field.name}</label>) : [])}</div>
      <label className="hx-public-confirm"><input type="checkbox" checked={confirmed} disabled={!canEdit || busy} onChange={e => setConfirmed(e.target.checked)} />{t('I understand anyone with the link can read these selected fields.')}</label>
      <button type="button" disabled={!canEdit || busy || !selected.length || !confirmed} onClick={() => void publish()}>{t('Create public link')}</button></>}
    </div></div>}
  </section>
}
