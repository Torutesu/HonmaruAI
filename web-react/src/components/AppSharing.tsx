import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

type Visibility = 'private' | 'workspace' | 'room'
interface Access { visibility: Visibility; version: number; roomChannel?: string | null }
interface Share { id: string; createdAt: string; expiresAt: string; revokedAt: string | null }
export function AppSharing({ httpBase, orgId, sessionToken, appId, appVersion }: { httpBase: string; orgId: string; sessionToken: string; appId: string; appVersion: number }) {
  const t = useT()
  const [access, setAccess] = useState<Access | null>(null)
  const [rooms, setRooms] = useState<string[]>([])
  const [room, setRoom] = useState('')
  const [canEdit, setCanEdit] = useState(false)
  const [canManage, setCanManage] = useState(false)
  const [canPublicShare, setCanPublicShare] = useState(false)
  const [shares, setShares] = useState<Share[]>([])
  const [expiresInDays, setExpiresInDays] = useState(7)
  const [consent, setConsent] = useState(false)
  const [createdUrl, setCreatedUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const headers = { 'content-type': 'application/json', 'x-session-token': sessionToken }
  const loadShares = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(`${httpBase}/apps/${appId}/public-shares?${new URLSearchParams({ orgId })}`, { headers, signal })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || String(res.status))
    setShares(data.shares || [])
  }, [httpBase, orgId, sessionToken, appId])
  useEffect(() => {
    const controller = new AbortController()
    setAccess(null); setCanEdit(false); setError('')
    fetch(`${httpBase}/apps/${appId}/access?${new URLSearchParams({ orgId })}`, { headers: { 'x-session-token': sessionToken }, signal: controller.signal })
      .then(async res => { const data = await res.json(); if (!res.ok) throw new Error(data.message || String(res.status)); return data })
      .then(data => { if (!controller.signal.aborted) { setAccess(data.access); setRooms(data.rooms || []); setRoom(data.access?.roomChannel || data.rooms?.[0] || ''); setCanEdit(Boolean(data.canEdit)); setCanManage(Boolean(data.canManage)); setCanPublicShare(Boolean(data.canPublicShare)); if(data.canManage) void loadShares(controller.signal).catch(err => { if (!controller.signal.aborted) setError(String(err.message)) }) } })
      .catch(err => { if (!controller.signal.aborted) setError(String(err.message)) })
    // Public link inventory is restricted to app owners and workspace admins.\n    // The access response controls the UI; the server remains authoritative.\n    
    return () => controller.abort()
  }, [httpBase, orgId, sessionToken, appId, loadShares])
  const save = async (visibility: Visibility, channel?: string) => {
    if (!access) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${httpBase}/apps/${appId}/access`, { method: 'PUT', headers, body: JSON.stringify({ orgId, visibility, ...(visibility === 'room' ? { channel } : {}), version: access.version }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      setAccess(data.access)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const createShare = async () => {
    setBusy(true); setError(''); setCreatedUrl('')
    try {
      const res = await fetch(`${httpBase}/apps/${appId}/public-shares`, { method: 'POST', headers, body: JSON.stringify({ orgId, version: appVersion, accessVersion: access?.version, confirmDataExposure: consent, expiresInDays }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      setCreatedUrl(`${location.origin}/#/app-share/${data.token}`)
      setConsent(false)
      await loadShares()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const revoke = async (shareId: string) => {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${httpBase}/apps/${appId}/public-shares/${shareId}/revoke?${new URLSearchParams({ orgId })}`, { method: 'POST', headers })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      await loadShares()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return <section>
    <div className="rows-title">{t('Sharing')}</div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {access && <div className="row static"><span className="row-main">
      <select aria-label={t('App visibility')} value={access.visibility} disabled={!canEdit || busy} onChange={e => void save(e.target.value as Visibility, room)}>
        <option value="workspace">{t('Workspace members')}</option><option value="private">{t('Only me')}</option><option value="room">{t('Selected room')}</option>
      </select>
      {access.visibility === 'room' && <select aria-label={t('Room')} value={room} disabled={!canEdit || busy || !rooms.length} onChange={e => { setRoom(e.target.value); void save('room', e.target.value) }}>
        {rooms.map(channel => <option key={channel} value={channel}>{channel}</option>)}
      </select>}
      <span className="row-sub">{t('Sharing applies to this app and its records. Room access is checked against current membership.')}</span>
    </span></div>}
    {canPublicShare && <div className="row static"><span className="row-main">
      <strong>{t('Anyone with a link')}</strong>
      <span className="row-sub">{t('Anyone with the link can read the published app and its current records. The link expires and can be revoked.')}</span>
      <label><input type="checkbox" checked={consent} disabled={!canManage || busy} onChange={e => setConsent(e.target.checked)} />{t('I confirm this app and its current records may be read by anyone with the link.')}</label>
      <select aria-label={t('Link expiry')} value={expiresInDays} disabled={!canManage || busy} onChange={e => setExpiresInDays(Number(e.target.value))}>
        {[1,7,30,90].map(days => <option key={days} value={days}>{days} {t('days')}</option>)}
      </select>
      <button className="pill-btn" disabled={!canManage || busy || !consent} onClick={() => void createShare()}>{t('Create link')}</button>
      {createdUrl && <p role="status"><a href={createdUrl}>{createdUrl}</a> {t('Copy this link now; it is shown only once.')}</p>}
      {shares.map(share => <div key={share.id} className="row-sub">{t('Expires')} {new Date(share.expiresAt).toLocaleString()} · {share.revokedAt ? t('Revoked') : <button className="pill-btn" disabled={!canManage || busy} onClick={() => void revoke(share.id)}>{t('Revoke link')}</button>}</div>)}
    </span></div>}
  </section>
}
