import './ExternalAppSharing.css'
import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { ExternalCollaboratorPicker } from './ExternalCollaboratorPicker'
import type { ExternalCollaborator } from '../utils/externalCollaborators'

interface Guest { githubId: string; login: string; name?: string | null; email?: string | null; permission: 'view' | 'edit'; expiresAt: string | null }
interface Invite { id: string; invitedEmail: string; permission: 'view' | 'edit'; accessExpiresAt: string | null; inviteExpiresAt: string }
interface SendRequest { id: string; tableId: string; rowId: string; guestGithubId: string; name?: string | null; login: string; email?: string | null; body: string; requestedAt: string }
interface ShareState { guests: Guest[]; invites: Invite[]; requests: SendRequest[]; canManage: boolean; customUnsupported?: boolean }
interface AudienceState { audience: null | { type: 'workspace'|'room'; roomId?: string; permission: 'view'|'edit'; expiresAt: string|null; version: number }; version: number; rooms: Array<{id:string;name:string}> }
const headers = (sessionToken: string, json = false) => ({ 'x-session-token': sessionToken, ...(json ? { 'content-type': 'application/json' } : {}) })

export function ExternalAppSharing({ httpBase, orgId, sessionToken, appId }: { httpBase: string; orgId: string; sessionToken: string; appId: string }) {
  const t = useT()
  const [sharing, setSharing] = useState<ShareState | null>(null)
  const [email, setEmail] = useState('')
  const [selectedCollaborator, setSelectedCollaborator] = useState<ExternalCollaborator|null>(null)
  const [permission, setPermission] = useState<'view' | 'edit'>('view')
  const [expiry, setExpiry] = useState('never')
  const [inviteUrl, setInviteUrl] = useState('')
  const [inviteDelivery, setInviteDelivery] = useState<'sent'|'failed'|'not_configured'|''>('')
  const [copyStatus, setCopyStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [audience, setAudience] = useState<AudienceState|null>(null)
  const [audienceType, setAudienceType] = useState<'none'|'workspace'|'room'>('none')
  const [audienceRoom, setAudienceRoom] = useState('')
  const [audiencePermission, setAudiencePermission] = useState<'view'|'edit'>('view')
  const base = `${httpBase}/external/apps/${encodeURIComponent(orgId)}/${encodeURIComponent(appId)}/sharing`
  const audienceUrl = `${httpBase}/hx/apps/${encodeURIComponent(appId)}/external-audience?orgId=${encodeURIComponent(orgId)}`
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
    const audienceRes = await fetch(audienceUrl, { headers: headers(sessionToken), signal })
    if (audienceRes.ok) {
      const current = await audienceRes.json() as AudienceState
      setAudience(current); setAudienceType(current.audience?.type || 'none'); setAudienceRoom(current.audience?.roomId || '')
      setAudiencePermission(current.audience?.permission || 'view')
    }
  }, [base, audienceUrl, sessionToken])
  useEffect(() => {
    const controller = new AbortController()
    setError(''); setSharing(null)
    loadSharing(controller.signal).catch(err => { if (!controller.signal.aborted) setError(String(err.message)) })
    return () => controller.abort()
  }, [loadSharing])

  const selectedExpiry = () => expiry === 'never' ? null : new Date(Date.now() + Number(expiry) * 86400000).toISOString()
  const invite = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true); setError(''); setInviteUrl(''); setInviteDelivery(''); setCopyStatus('')
    try {
      const res = await fetch(base, { method: 'POST', headers: headers(sessionToken, true), body: JSON.stringify({ email, permission, expiresAt: selectedExpiry() }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      const appOrigin = typeof window !== 'undefined' ? window.location.origin : httpBase
      setInviteUrl(new URL(`/#/external-invite/${data.invite.token}`, appOrigin).toString())
      setInviteDelivery(data.invite.emailDelivery?.status || 'not_configured')
      setEmail('')
      await loadSharing()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const shareWithPerson = async () => {
    if (!selectedCollaborator) return
    setBusy(true); setError('')
    try {
      const res = await fetch(base, { method:'POST', headers:headers(sessionToken,true), body:JSON.stringify({ recipientGithubId:selectedCollaborator.githubId, permission, expiresAt:selectedExpiry() }) })
      const data = await res.json().catch(()=>null)
      if (!res.ok) throw new Error(data?.message || String(res.status))
      setSelectedCollaborator(null)
      await loadSharing()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const copyInviteLink = async () => {
    if (!inviteUrl) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(inviteUrl)
      setCopyStatus(t('Invite link copied.'))
    } catch {
      setCopyStatus(t('Copy was unavailable. Select the link above and copy it manually.'))
    }
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
  const updateInvite = async (invitation: Invite, nextPermission: 'view'|'edit' = invitation.permission, nextExpiry = invitation.accessExpiresAt) => {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${base}/invites/${encodeURIComponent(invitation.id)}`, { method: 'PATCH', headers: headers(sessionToken, true), body: JSON.stringify({ permission: nextPermission, accessExpiresAt: nextExpiry }) })
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
  const saveAudience = async () => {
    if (!audience) return
    setBusy(true); setError('')
    try {
      const res = await fetch(audienceUrl, { method:'PUT', headers:headers(sessionToken,true), body:JSON.stringify({version:audience.version,type:audienceType==='none'?null:audienceType,roomId:audienceType==='room'?audienceRoom:null,permission:audienceType==='none'?null:audiencePermission,expiresAt:audience.audience?.expiresAt||null}) })
      const data = await res.json().catch(()=>({}))
      if (!res.ok) throw new Error(data.message || String(res.status))
      await loadSharing()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  if (!sharing?.canManage) return null
  return <>
    {sharing?.canManage && <div className="app-guest-sharing">
      {audience && <section className="app-guest-audience" aria-label={t('Workspace and Room access')}>
        <h3>{t('Workspace and Room access')}</h3>
        <label>{t('Audience')}<select value={audienceType} disabled={busy} onChange={event=>setAudienceType(event.target.value as 'none'|'workspace'|'room')}><option value="none">{t('No audience')}</option><option value="workspace">{t('Workspace members')}</option><option value="room">{t('Room members')}</option></select></label>
        {audienceType==='room' && <label>{t('Room')}<select value={audienceRoom} disabled={busy} onChange={event=>setAudienceRoom(event.target.value)}><option value="">{t('Choose a Room')}</option>{audience.rooms.map(room=><option key={room.id} value={room.id}>{room.name}</option>)}</select></label>}
        {audienceType!=='none' && <label>{t('Permission')}<select value={audiencePermission} disabled={busy} onChange={event=>setAudiencePermission(event.target.value as 'view'|'edit')}><option value="view">{t('View')}</option><option value="edit">{t('Edit')}</option></select></label>}
        <button className="btn" type="button" disabled={busy || (audienceType==='room'&&!audienceRoom)} onClick={()=>void saveAudience()}>{t('Save audience')}</button>
      </section>}
      <h3>{t('External guests')}</h3>
      <p className="row-sub">{t('Invite a named person to this App. They must verify the invited email address. Access stays limited to this App and its linked records.')}</p>
      {sharing.customUnsupported && <div className="form-error" role="status">{t('Publish this Custom App before inviting external guests.')}</div>}
      {!sharing.customUnsupported && <>
      <div className="app-guest-invite">
        <ExternalCollaboratorPicker httpBase={httpBase} sessionToken={sessionToken} orgId={orgId} resourceType="app" resourceId={appId} value={selectedCollaborator} onChange={setSelectedCollaborator} disabled={busy}/>
        <label>{t('Permission')}<select aria-label={t('Existing collaborator permission')} value={permission} onChange={event => setPermission(event.target.value as 'view' | 'edit')}><option value="view">{t('View')}</option><option value="edit">{t('Edit')}</option></select></label>
        <label>{t('Access expires')}<select aria-label={t('Existing collaborator access expiry')} value={expiry} onChange={event => setExpiry(event.target.value)}><option value="never">{t('Never')}</option><option value="7">{t('In 7 days')}</option><option value="30">{t('In 30 days')}</option><option value="90">{t('In 90 days')}</option></select></label>
        <button className="btn btn-primary" type="button" disabled={busy||!selectedCollaborator} onClick={()=>void shareWithPerson()}>{t('Share with person')}</button>
      </div>
      <form onSubmit={invite} className="app-guest-invite">
        <label>{t('Email')}<input aria-label={t('Guest email')} type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>{t('Permission')}<select aria-label={t('Guest permission')} value={permission} onChange={event => setPermission(event.target.value as 'view' | 'edit')}><option value="view">{t('View')}</option><option value="edit">{t('Edit')}</option></select></label>
        <label>{t('Access expires')}<select aria-label={t('Guest access expiry')} value={expiry} onChange={event => setExpiry(event.target.value)}><option value="never">{t('Never')}</option><option value="7">{t('In 7 days')}</option><option value="30">{t('In 30 days')}</option><option value="90">{t('In 90 days')}</option></select></label>
        <button className="btn btn-primary" type="submit" disabled={busy}>{t('Create invite')}</button>
      </form>
      {inviteUrl && <div className="app-guest-link"><span>{inviteDelivery === 'sent' ? t('Invitation email sent. You can also copy the one-time link.') : inviteDelivery === 'failed' ? t('Email could not be delivered. Copy the one-time link and share it with the invited person.') : t('Email delivery is not configured. Copy the one-time link and share it with the invited person.')}</span><div><input aria-label={t('One-time invite link')} readOnly value={inviteUrl} onFocus={event => event.currentTarget.select()} /><button className="btn" type="button" onClick={() => void copyInviteLink()}>{t('Copy link')}</button></div><span role="status" aria-live="polite">{copyStatus}</span></div>}
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
          <span>{invitation.invitedEmail}</span><span>{t('Invite pending')} · {t('Invite expires {date}', { date: new Date(invitation.inviteExpiresAt).toLocaleDateString() })}</span>
          <label>{t('Permission')}<select aria-label={t('Permission for {email}', { email: invitation.invitedEmail })} value={invitation.permission} disabled={busy} onChange={event => void updateInvite(invitation, event.target.value as 'view'|'edit')}><option value="view">{t('View')}</option><option value="edit">{t('Edit')}</option></select></label>
          <label>{t('Access expires')}<select aria-label={t('Access expiry for {email}', { email: invitation.invitedEmail })} value="unchanged" disabled={busy} onChange={event => { const days = event.target.value; if (days === 'unchanged') return; void updateInvite(invitation, invitation.permission, days === 'never' ? null : new Date(Date.now() + Number(days) * 86400000).toISOString()) }}><option value="unchanged">{invitation.accessExpiresAt ? t('Expires {date}', { date: new Date(invitation.accessExpiresAt).toLocaleDateString() }) : t('No expiry')}</option><option value="never">{t('Never')}</option><option value="7">{t('In 7 days')}</option><option value="30">{t('In 30 days')}</option><option value="90">{t('In 90 days')}</option></select></label>
          <button className="btn" type="button" disabled={busy} onClick={() => void revoke(`invites/${encodeURIComponent(invitation.id)}`)}>{t('Revoke invite')}</button>
        </li>)}
      </ul>
    </div>}
  </>
}
