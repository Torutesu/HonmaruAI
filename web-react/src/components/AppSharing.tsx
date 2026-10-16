import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

interface Access { visibility: 'private' | 'workspace'; version: number }
export function AppSharing({ httpBase, orgId, sessionToken, appId }: { httpBase: string; orgId: string; sessionToken: string; appId: string }) {
  const t = useT()
  const [access, setAccess] = useState<Access | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setAccess(null); setCanEdit(false); setError('')
    fetch(`${httpBase}/apps/${appId}/access?${new URLSearchParams({ orgId })}`, { headers: { 'x-session-token': sessionToken }, signal: controller.signal })
      .then(async res => { const data = await res.json(); if (!res.ok) throw new Error(data.message || String(res.status)); return data })
      .then(data => { if (!controller.signal.aborted) { setAccess(data.access); setCanEdit(data.canEdit) } })
      .catch(err => { if (!controller.signal.aborted) setError(String(err.message)) })
    return () => controller.abort()
  }, [httpBase, orgId, sessionToken, appId])
  const save = async (visibility: Access['visibility']) => {
    if (!access) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${httpBase}/apps/${appId}/access`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-session-token': sessionToken }, body: JSON.stringify({ orgId, visibility, version: access.version }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      setAccess(data.access)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return <section>
    <div className="rows-title">{t('Sharing')}</div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {access && <div className="row static"><span className="row-main">
      <select aria-label={t('App visibility')} value={access.visibility} disabled={!canEdit || busy} onChange={e => void save(e.target.value as Access['visibility'])}>
        <option value="workspace">{t('Workspace members')}</option><option value="private">{t('Only me')}</option>
      </select>
      <span className="row-sub">{t('Sharing applies to this app and its records. Room links do not change access.')}</span>
    </span></div>}
  </section>
}
