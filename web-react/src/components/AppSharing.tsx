import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

type Visibility = 'private' | 'workspace' | 'room'
interface Access { visibility: Visibility; version: number; roomChannel?: string | null }
interface PersonAccess { userId: string; login: string; name: string; permission: 'none' | 'view' | 'edit'; explicit: boolean; canOverride?: boolean; role?: 'owner' | 'admin' | 'member' | 'guest' }
interface AccessResponse { access: Access; people?: PersonAccess[]; rooms?: string[]; canEdit?: boolean; canManage?: boolean; canPublicShare?: boolean; message?: string }
interface Share { id: string; createdAt: string; expiresAt: string; revokedAt: string | null }
interface ApprovalRequest { id: string; requesterLogin: string; agentId: string; roomChannel: string; appVersion: number; accessVersion: number; status: 'pending' | 'approved' | 'declined' | 'stale'; createdAt: string }
const MAX_PEOPLE = 100
export function AppSharing({ httpBase, orgId, sessionToken, appId, appVersion }: { httpBase: string; orgId: string; sessionToken: string; appId: string; appVersion: number }) {
  const t = useT()
  const [access, setAccess] = useState<Access | null>(null)
  const [people, setPeople] = useState<PersonAccess[]>([])
  const [filter, setFilter] = useState('')
  const [rooms, setRooms] = useState<string[]>([])
  const [room, setRoom] = useState('')
  const [canEdit, setCanEdit] = useState(false)
  const [canManage, setCanManage] = useState(false)
  const [canPublicShare, setCanPublicShare] = useState(false)
  const [shares, setShares] = useState<Share[]>([])
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([])
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
  const loadApprovalRequests = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(`${httpBase}/apps/${appId}/public-share-approvals?${new URLSearchParams({ orgId })}`, { headers, signal })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || String(res.status))
    setApprovalRequests(data.requests || [])
  }, [httpBase, orgId, sessionToken, appId])
  useEffect(() => {
    const controller = new AbortController()
    setAccess(null); setCanEdit(false); setCanManage(false); setError('')
    fetch(`${httpBase}/apps/${appId}/access?${new URLSearchParams({ orgId })}`, { headers: { 'x-session-token': sessionToken }, signal: controller.signal })
      .then(async res => { const data = await res.json(); if (!res.ok) throw new Error(data.message || String(res.status)); return data as AccessResponse })
      .then(data => {
        if (controller.signal.aborted) return
        setAccess(data.access)
        setPeople(Array.isArray(data.people) ? data.people.map(person => ({ ...person, explicit: Boolean(person.explicit) })) : [])
        setRooms(data.rooms || [])
        setRoom(data.access?.roomChannel || data.rooms?.[0] || '')
        setCanEdit(Boolean(data.canEdit)); setCanManage(Boolean(data.canManage)); setCanPublicShare(Boolean(data.canPublicShare))
        if (data.canManage) {
          void loadShares(controller.signal).catch(err => { if (!controller.signal.aborted) setError(String(err.message)) })
          void loadApprovalRequests(controller.signal).catch(err => { if (!controller.signal.aborted) setError(String(err.message)) })
        }
      })
      .catch(err => { if (!controller.signal.aborted) setError(String(err.message)) })
    return () => controller.abort()
  }, [httpBase, orgId, sessionToken, appId, loadShares, loadApprovalRequests])
  const save = async (visibility: Visibility, channel?: string, nextPeople = people) => {
    if (!access) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${httpBase}/apps/${appId}/access`, { method: 'PUT', headers, body: JSON.stringify({ orgId, visibility, ...(visibility === 'room' ? { channel } : {}), version: access.version, people: nextPeople.filter(person => person.explicit && person.canOverride !== false && person.role !== 'owner' && person.role !== 'admin').map(({ userId, permission }) => ({ userId, permission })) }) })
      const data: AccessResponse = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      setAccess(data.access)
      setPeople(Array.isArray(data.people) ? data.people.map(person => ({ ...person, explicit: Boolean(person.explicit) })) : nextPeople)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const setPermission = (person: PersonAccess, permission: PersonAccess['permission'] | 'inherit') => {
    const next = people.map(candidate => candidate.userId === person.userId
      ? permission === 'inherit' ? { ...candidate, explicit: false } : { ...candidate, permission, explicit: true }
      : candidate)
    void save(access?.visibility || 'workspace', access?.roomChannel || undefined, next)
  }
  const createShare = async () => {
    if (!access) return
    setBusy(true); setError(''); setCreatedUrl('')
    try {
      const res = await fetch(`${httpBase}/apps/${appId}/public-shares`, { method: 'POST', headers, body: JSON.stringify({ orgId, version: appVersion, accessVersion: access.version, confirmDataExposure: consent, expiresInDays }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      const shareUrl = `${location.origin}/#/app-share/${data.token}`
      setConsent(false)
      try { await loadShares() } finally { setCreatedUrl(shareUrl) }
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
  const reviewApprovalRequest = async (requestId: string, decision: 'approve' | 'decline') => {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${httpBase}/apps/${appId}/public-share-approvals?${new URLSearchParams({ orgId })}`, { method: 'POST', headers, body: JSON.stringify({ orgId, requestId, decision }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      await loadApprovalRequests()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const matchingPeople = people.filter(person => `${person.name} ${person.login}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const visiblePeople = matchingPeople.slice(0, MAX_PEOPLE)
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
    {access && people.length > 0 && <section className="app-sharing-people" aria-labelledby={`app-sharing-people-title-${appId}`}>
      <h3 className="rows-title" id={`app-sharing-people-title-${appId}`}>{t('Person access')}</h3>
      <label className="app-sharing-filter">{t('Find a person')}<input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('Name or username')} /></label>
      <div className="app-sharing-person-list">{visiblePeople.map(person => <div className="row static app-sharing-person" key={person.userId}>
        <span className="row-main"><span>{person.name || person.login}</span><span className="row-sub">@{person.login}</span></span>
        <select aria-label={t('Access for {{name}}', { name: person.name || person.login })} value={person.explicit ? person.permission : 'inherit'} disabled={!canEdit || busy || person.canOverride === false || person.role === 'owner' || person.role === 'admin'} onChange={event => setPermission(person, event.target.value as PersonAccess['permission'] | 'inherit')}>
          <option value="inherit">{t('Inherit default ({{permission}})', { permission: person.permission === 'none' ? t('No access') : person.permission === 'view' ? t('View only') : t('Can edit') })}</option>
          <option value="none">{t('No access')}</option><option value="view">{t('View only')}</option><option value="edit">{t('Can edit')}</option>
        </select>
      </div>)}{visiblePeople.length === 0 && <div className="row-sub">{t('No people match this search.')}</div>}</div>
      {matchingPeople.length > MAX_PEOPLE && <div className="row-sub">{t('Showing {{shown}} of {{count}} people.', { shown: MAX_PEOPLE, count: matchingPeople.length })}</div>}
      <p className="row-sub">{t('No access overrides workspace visibility for this person.')}</p>
    </section>}
    {canManage && approvalRequests.length > 0 && <div className="row static"><span className="row-main">
      <strong>{t('Agent link approval requests')}</strong><span className="row-sub">{t('Approving authorizes link creation for the exact published revision. No link is created until you create one below.')}</span>
      {approvalRequests.map(request => <div key={request.id} className="row-sub"><span>{request.agentId} · #{request.roomChannel} · v{request.appVersion} · {request.requesterLogin} · {t(request.status)}</span>{request.status === 'pending' && <span><button className="pill-btn" disabled={busy} onClick={() => void reviewApprovalRequest(request.id, 'approve')}>{t('Approve')}</button><button className="pill-btn" disabled={busy} onClick={() => void reviewApprovalRequest(request.id, 'decline')}>{t('Decline')}</button></span>}</div>)}
    </span></div>}
    {canPublicShare && <div className="row static"><span className="row-main">
      <strong>{t('Anyone with a link')}</strong><span className="row-sub">{t('Anyone with the link can read the published app and its current records. The link expires and can be revoked.')}</span>
      <label><input type="checkbox" checked={consent} disabled={!canManage || busy} onChange={e => setConsent(e.target.checked)} />{t('I confirm this app and its current records may be read by anyone with the link.')}</label>
      <select aria-label={t('Link expiry')} value={expiresInDays} disabled={!canManage || busy} onChange={e => setExpiresInDays(Number(e.target.value))}>{[1,7,30,90].map(days => <option key={days} value={days}>{days} {t('days')}</option>)}</select>
      <button className="pill-btn" disabled={!canManage || busy || !consent} onClick={() => void createShare()}>{t('Create link')}</button>
      {createdUrl && <p role="status"><a href={createdUrl}>{createdUrl}</a> {t('Copy this link now; it is shown only once.')}</p>}
      {shares.map(share => <div key={share.id} className="row-sub">{t('Expires')} {new Date(share.expiresAt).toLocaleString()} · {share.revokedAt ? t('Revoked') : <button className="pill-btn" disabled={!canManage || busy} onClick={() => void revoke(share.id)}>{t('Revoke link')}</button>}</div>)}
    </span></div>}
  </section>
}
