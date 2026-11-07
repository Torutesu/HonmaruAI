import './ExternalAppSharing.css'
import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

interface Guest { githubId: string; login: string; name?: string | null; email?: string | null; permission: 'view' | 'edit'; expiresAt: string | null }
interface Invite { id: string; invitedEmail: string; permission: 'view' | 'edit'; accessExpiresAt: string | null; inviteExpiresAt: string }
interface SendRequest { id: string; tableId: string; rowId: string; guestGithubId: string; name?: string | null; login: string; email?: string | null; body: string; requestedAt: string }
interface ShareState { guests: Guest[]; invites: Invite[]; requests: SendRequest[]; canManage: boolean; customUnsupported?: boolean }
const headers = (sessionToken: string, json = false) => ({ 'x-session-token': sessionToken, ...(json ? { 'content-type': 'application/json' } : {}) })

export function ExternalAppSharing({ httpBase, orgId, sessionToken, appId }: { httpBase: string; orgId: string; sessionToken: string; appId: string }) {
  const t = useT()
  const [sharing, setSharing] = useState<ShareState | null>(null)
  const [email, setEmail] = useState('')
  const [permission, setPermission] = useState<'view' | 'edit'>('view')
  const [expiry, setExpiry] = useState('never')
  const [inviteUrl, setInviteUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const base = `${httpBase}/external/apps/${encodeURIComponent(orgId)}/${encodeURIComponent(appId)}/sharing`
  const loadSharing = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(base, { headers: headers(sessionToken), signal })
    if (res.status === 404 || res.status === 403) { setSharing(null); return }
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || String(res.status))
    const queueRes = await fetch(`${base}/requests`, { headers: headers(sessionToken), signal })
    const queue = queueRes.ok ? await queueRes.json() : { requests: [] }
    setSharing({
      guests: Array.isArray(data.guests) ? data.guests : [],
      invites: Array.isArray(data.invites) ? data.invites : [],
      requests: Array.isArray(queue.requests) ? queue.requests : [],
      canManage: data.canManage === true,
      customUnsupported: data.customUnsupported === true,
    })
  }, [base, sessionToken])
  useEffect(() => {
    const controller = new AbortController()
    setError(''); setSharing(null)
    loadSharing(controller.signal).catch(err => { if (!controller.signal.aborted) setError(String(err.message)) })
    return () => controller.abort()
  }, [loadSharing])

  const selectedExpiry = () => expiry === 'never' ? null : new Date(Date.now() + Number(expiry) * 86400000).toISOString()
  const invite = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true); setError(''); setInviteUrl('')
    try {
      const res = await fetch(base, { method: 'POST', headers: headers(sessionToken, true), body: JSON.stringify({ email, permission, expiresAt: selectedExpiry() }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      const appOrigin = typeof window !== 'undefined' ? window.location.origin : httpBase
      setInviteUrl(new URL(`/#/external-invite/${data.invite.token}`, appOrigin).toString())
      setEmail('')
      await loadSharing()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const updateGuest = async (guest: Guest, nextPermission: 'view' | 'edit', nextExpiry = guest.expiresAt) => {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${base}/${encodeURIComponent(guest.githubId)}`, { method: 'PATCH', headers: headers(sessionToken, true), body: JSON.stringify({ permission: nextPermission, expiresAt: nextExpiry }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || String(res.status))
      await loadSharing()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const decideRequest = async (requestId: string, decision: 'approve' | 'reject') => {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${base}/requests/${encodeURIComponent(requestId)}`, { method: 'POST', headers: headers(sessionToken, true), body: JSON.stringify({ decision }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || String(res.status))
      await loadSharing()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const revoke = async (path: string) => {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${base}/${path}`, { method: 'DELETE', headers: headers(sessionToken) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || String(res.status))
      await loadSharing()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  if (!sharing?.canManage) return null
  return <>
    {sharing?.canManage && <div className="app-guest-sharing">
      <h3>{t('External guests')}</h3>
      <p className="row-sub">{t('Invite a named person to this App. They must verify the invited email address. Access stays limited to this App and its linked records.')}</p>
      {sharing.customUnsupported && <div className="form-error" role="status">{t('Custom Apps cannot be opened by external guests yet. Ask the owner for a Database App share.')}</div>}
      {!sharing.customUnsupported && <>
      <form onSubmit={invite} className="app-guest-invite">
        <label>{t('Email')}<input aria-label={t('Guest email')} type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>{t('Permission')}<select aria-label={t('Guest permission')} value={permission} onChange={event => setPermission(event.target.value as 'view' | 'edit')}><option value="view">{t('View')}</option><option value="edit">{t('Edit')}</option></select></label>
        <label>{t('Access expires')}<select aria-label={t('Guest access expiry')} value={expiry} onChange={event => setExpiry(event.target.value)}><option value="never">{t('Never')}</option><option value="7">{t('In 7 days')}</option><option value="30">{t('In 30 days')}</option><option value="90">{t('In 90 days')}</option></select></label>
        <button className="btn btn-primary" type="submit" disabled={busy}>{t('Create invite')}</button>
      </form>
      {inviteUrl && <div className="app-guest-link" role="status"><span>{t('Share this one-time link with the invited person')}</span><input aria-label={t('One-time invite link')} readOnly value={inviteUrl} onFocus={event => event.currentTarget.select()} /></div>}
      </>}
      {!sharing.customUnsupported && sharing.requests.length > 0 && <div className="app-guest-approvals" aria-label={t('Pending message approvals')}>
        <h4>{t('Pending message approvals')}</h4>
        <ul>{sharing.requests.map(request => <li key={request.id}>
          <span><strong>{request.name || request.login}</strong>{request.email ? ` · ${request.email}` : ''}: {request.body}</span>
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void decideRequest(request.id, 'approve')}>{t('Approve message')}</button>
          <button className="btn" type="button" disabled={busy} onClick={() => void decideRequest(request.id, 'reject')}>{t('Reject')}</button>
        </li>)}</ul>
      </div>}
      <ul className="app-guest-list" aria-label={t('App guests')}>
        {sharing.guests.map(guest => <li key={guest.githubId}>
          <span>{guest.name || guest.login}{guest.email ? ` · ${guest.email}` : ''}</span>
          {!sharing.customUnsupported && <>
          <select aria-label={t('Permission for {person}', { person: guest.name || guest.login })} value={guest.permission} disabled={busy} onChange={event => void updateGuest(guest, event.target.value as 'view' | 'edit')}><option value="view">{t('View')}</option><option value="edit">{t('Edit')}</option></select>
          <select aria-label={t('Access expiry for {person}', { person: guest.name || guest.login })} value="unchanged" disabled={busy} onChange={event => { const days = event.target.value; if (days === 'unchanged') return; void updateGuest(guest, guest.permission, days === 'never' ? null : new Date(Date.now() + Number(days) * 86400000).toISOString()) }}><option value="unchanged">{guest.expiresAt ? t('Expires {date}', { date: new Date(guest.expiresAt).toLocaleDateString() }) : t('No expiry')}</option><option value="never">{t('Never')}</option><option value="7">{t('In 7 days')}</option><option value="30">{t('In 30 days')}</option><option value="90">{t('In 90 days')}</option></select>
          </>}
          <button className="btn" type="button" disabled={busy} onClick={() => void revoke(encodeURIComponent(guest.githubId))}>{t('Revoke')}</button>
        </li>)}
        {sharing.invites.map(invitation => <li key={invitation.id}>
          <span>{invitation.invitedEmail}</span><span>{t('Invite pending')} · {invitation.permission}</span>
          <span>{invitation.accessExpiresAt ? t('Access expires {date}', { date: new Date(invitation.accessExpiresAt).toLocaleDateString() }) : t('No expiry')}</span>
          <button className="btn" type="button" disabled={busy} onClick={() => void revoke(`invites/${encodeURIComponent(invitation.id)}`)}>{t('Revoke invite')}</button>
        </li>)}
      </ul>
    </div>}
  </>
}
