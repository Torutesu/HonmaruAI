import React, { useEffect, useMemo, useState } from 'react'
import { Dialog } from './Dialog'
import { useT } from '../utils/i18n'
import {
  ExternalThreadShareError,
  getExternalThreadAudience,
  listExternalThreadShares,
  revokeExternalThreadShare,
  shareExternalThread,
  type ExternalThreadGrant,
  listExternalThreadInvitations,
  createExternalThreadInvitation,
  revokeExternalThreadInvitation,
  type ExternalThreadInvitation,
  listExternalThreadSendRequests,
  decideExternalThreadSendRequest,
  type ExternalThreadSendRequest,
  listExternalThreadLinkShares, createExternalThreadLinkShare, revokeExternalThreadLinkShare,
  type ExternalThreadLinkShare,
  type ExternalThreadAudience,
  type ExternalThreadAudienceRoom,
  updateExternalThreadAudience,
} from '../utils/externalThreadSharing'
import './ExternalThreadShare.css'
import { ExternalCollaboratorPicker } from './ExternalCollaboratorPicker'
import type { ExternalCollaborator } from '../utils/externalCollaborators'

type Api = { httpBase: string; orgId: string; sessionToken: string }
type Expiry = '7d' | '30d' | 'never' | 'current'
const expiryMs: Record<'7d' | '30d', number> = { '7d': 7 * 86400000, '30d': 30 * 86400000 }
function nextExpiry(value: Expiry, currentExpiry?: string | null) {
  if (value === 'current') return currentExpiry ?? null
  return value === 'never' ? null : new Date(Date.now() + expiryMs[value as '7d' | '30d']).toISOString()
}
function errorText(error: unknown, t: (text: string) => string) {
  if (error instanceof ExternalThreadShareError && error.status === 404) return t('An existing verified account outside this workspace is required.')
  return t('Access could not be updated. Check the connection and your permission, then try again.')
}

export function ExternalThreadShare({ api, threadId, onClose }: { api: Api; threadId: string; onClose: () => void }) {
  const t = useT()
  const [shares, setShares] = useState<ExternalThreadGrant[]>([])
  const [invitations, setInvitations] = useState<ExternalThreadInvitation[]>([])
  const [sendRequests, setSendRequests] = useState<ExternalThreadSendRequest[]>([])
  const [linkShares, setLinkShares] = useState<ExternalThreadLinkShare[]>([])
  const [audience, setAudience] = useState<ExternalThreadAudience | null>(null)
  const [audienceVersion, setAudienceVersion] = useState(0)
  const [audienceRooms, setAudienceRooms] = useState<ExternalThreadAudienceRoom[]>([])
  const [audienceType, setAudienceType] = useState<'workspace' | 'room' | 'none'>('workspace')
  const [audienceRoomId, setAudienceRoomId] = useState('')
  const [audiencePermission, setAudiencePermission] = useState<'view' | 'edit'>('view')
  const [audienceExpiry, setAudienceExpiry] = useState<Expiry>('7d')
  const [audienceLoading, setAudienceLoading] = useState(true)
  const [audienceError, setAudienceError] = useState('')
  const [audienceConflict, setAudienceConflict] = useState(false)
  const [publicLink, setPublicLink] = useState('')
  const [linkPermission, setLinkPermission] = useState<'view'|'edit'>('view')
  const [linkExpiry, setLinkExpiry] = useState<Expiry>('7d')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteUrl, setInviteUrl] = useState('')
  const [inviteDelivery, setInviteDelivery] = useState<'sent'|'failed'|'not_configured'|''>('')
  const [invitePermission, setInvitePermission] = useState<'view'|'edit'>('view')
  const [inviteExpiry, setInviteExpiry] = useState<Expiry>('7d')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [selectedCollaborator, setSelectedCollaborator] = useState<ExternalCollaborator|null>(null)
  const [permission, setPermission] = useState<'view'|'edit'>('view')
  const [expiry, setExpiry] = useState<Expiry>('7d')
  const [drafts, setDrafts] = useState<Record<string, 'view'|'edit'>>({})
  const apiKey = useMemo(() => ({ ...api }), [api.httpBase, api.orgId, api.sessionToken])
  useEffect(() => {
    const controller = new AbortController()
    let live = true
    setLoading(true); setError('')
    void Promise.all([
      listExternalThreadShares(apiKey, threadId, controller.signal),
      listExternalThreadInvitations(apiKey, threadId, controller.signal),
      listExternalThreadSendRequests(apiKey, threadId, controller.signal),
      listExternalThreadLinkShares(apiKey, threadId, controller.signal),
    ])
      .then(([value, pending, requests, links]) => { if (live) { setShares(value); setInvitations(pending); setSendRequests(requests); setLinkShares(links); setDrafts(Object.fromEntries(value.map(item => [item.id,item.permission]))) } })
      .catch(err => { if (live && !controller.signal.aborted) setError(errorText(err,t)) })
      .finally(() => { if (live) setLoading(false) })
    setAudienceLoading(true)
    void getExternalThreadAudience(apiKey, threadId, controller.signal)
      .then(value => {
        if (!live) return
        setAudience(value.audience)
        setAudienceVersion(value.version)
        setAudienceRooms(value.rooms)
        setAudienceConflict(false)
        setAudienceError('')
        if (value.audience) {
          setAudienceType(value.audience.type)
          setAudienceRoomId(value.audience.roomId || value.rooms[0]?.id || '')
          setAudiencePermission(value.audience.permission)
          setAudienceExpiry('current')
        } else {
          setAudienceType('workspace')
          setAudienceRoomId(value.rooms[0]?.id || '')
          setAudiencePermission('view')
          setAudienceExpiry('7d')
        }
      })
      .catch(err => { if (live && !controller.signal.aborted) setAudienceError(errorText(err,t)) })
      .finally(() => { if (live) setAudienceLoading(false) })
    return () => { live = false; controller.abort() }
  }, [apiKey, threadId, attempt])

  const mutate = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action(); setAttempt(n => n + 1) }
    catch (err) { setError(errorText(err,t)) }
    finally { setBusy(false) }
  }
  const createInvite = (event: React.FormEvent) => {
    event.preventDefault()
    const value = inviteEmail.trim()
    if (!value) return
    void mutate(async () => {
      const invite = await createExternalThreadInvitation(apiKey, threadId, {
        email: value, permission: invitePermission, accessExpiresAt: nextExpiry(inviteExpiry),
      })
      setInviteUrl(invite.inviteUrl)
      setInviteDelivery(invite.emailDelivery)
      setInviteEmail('')
    })
  }
  const createLink = (event:React.FormEvent) => {
    event.preventDefault()
    void mutate(async()=>{const created=await createExternalThreadLinkShare(apiKey,threadId,{permission:linkPermission,expiresAt:nextExpiry(linkExpiry)});setPublicLink(created.inviteUrl)})
  }
  const revokeLink = (link:ExternalThreadLinkShare) => void mutate(async()=>{await revokeExternalThreadLinkShare(apiKey,threadId,link.id)})
  const copyInvite = async () => {
    if (!inviteUrl) return
    await navigator.clipboard.writeText(inviteUrl)
  }
  const revokeInvite = (invite: ExternalThreadInvitation) => void mutate(async () => {
    await revokeExternalThreadInvitation(apiKey, threadId, invite.id)
  })
  const add = (event: React.FormEvent) => {
    event.preventDefault()
    if (!selectedCollaborator) return
    void mutate(async () => {
      await shareExternalThread(apiKey,threadId,{recipientGithubId:selectedCollaborator.githubId,permission,expiresAt:nextExpiry(expiry)})
      setSelectedCollaborator(null)
    })
  }
  const update = (share: ExternalThreadGrant) => {
    const next = drafts[share.id] || share.permission
    if (next === share.permission) return
    void mutate(async () => {
      await shareExternalThread(apiKey,threadId,{email:share.recipient.email,permission:next,expiresAt:share.expiresAt})
    })
  }
  const revoke = (share: ExternalThreadGrant) => void mutate(async () => {
    await revokeExternalThreadShare(apiKey,threadId,share.id)
  })
  const decideRequest = (request: ExternalThreadSendRequest, decision: 'approve'|'reject') => void mutate(async () => {
    await decideExternalThreadSendRequest(apiKey, threadId, request.id, decision)
  })
  const saveAudience = async (requestedType: 'workspace' | 'room' | 'none' = audienceType) => {
    if (busy || requestedType === 'room' && !audienceRoomId) return
    setBusy(true); setAudienceError(''); setError(''); setAudienceConflict(false)
    try {
      await updateExternalThreadAudience(apiKey, threadId, {
        version: audienceVersion,
        type: requestedType === 'none' ? null : requestedType,
        ...(requestedType === 'room' ? { roomId: audienceRoomId } : {}),
        ...(requestedType === 'none' ? {} : {
          permission: audiencePermission,
          expiresAt: nextExpiry(audienceExpiry, audience?.expiresAt),
        }),
      })
      setAttempt(n => n + 1)
    } catch (err) {
      if (err instanceof ExternalThreadShareError && err.status === 409) {
        setAudienceConflict(true)
        setAudienceError(t('Room settings or membership changed. Reload before saving.'))
      } else {
        setAudienceError(errorText(err,t))
      }
    } finally { setBusy(false) }
  }
  const expires = (value: string | null) => value ? new Date(value).toLocaleString() : t('No expiry')

  return <Dialog
    title={t('Share thread with people')}
    lede={t('Only these people can open this thread. Sharing never adds workspace membership.')}
    onClose={onClose}
    className="hx-external-thread-share"
    footer={<button type="button" className="pill-btn" onClick={onClose}>{t('Done')}</button>}
  >
    <form className="hx-external-thread-share-form" onSubmit={add}>
      <ExternalCollaboratorPicker httpBase={api.httpBase} sessionToken={api.sessionToken} orgId={api.orgId} resourceType="thread" resourceId={threadId} value={selectedCollaborator} onChange={setSelectedCollaborator} disabled={busy}/>
      <div className="hx-external-thread-share-options">
        <label>{t('Permission')}
          <select aria-label={t('Permission')} value={permission} disabled={busy} onChange={event=>setPermission(event.target.value as 'view'|'edit')}>
            <option value="view">{t('Can view')}</option><option value="edit">{t('Can edit')}</option>
          </select>
        </label>
        <label>{t('Expires')}
          <select aria-label={t('Expires')} value={expiry} disabled={busy} onChange={event=>setExpiry(event.target.value as Expiry)}>
            <option value="7d">{t('In 7 days')}</option><option value="30d">{t('In 30 days')}</option><option value="never">{t('Never')}</option>
          </select>
        </label>
      </div>
      <button type="submit" className="pill-btn" disabled={busy||!selectedCollaborator}>{busy?t('Saving…'):t('Share thread')}</button>
    </form>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <section className="hx-external-thread-audience hx-external-thread-invites" aria-label={t('Sharing')}>
      <h3>{t('Sharing')}</h3>
      {audienceLoading&&<p role="status">{t('Loading…')}</p>}
      {!audienceLoading&&audience&&<p className="row-sub" role="status">
        {audience.type === 'workspace' ? t('Workspace members') : <>{t('Room')} · {audienceRooms.find(room => room.id === audience.roomId)?.name || audience.roomId}</>}
        {' · '}{t(audience.permission === 'edit' ? 'Can edit' : 'Can view')}{' · '}{t('Expires')} {expires(audience.expiresAt)}
      </p>}
      {!audienceLoading&&!audience&&<p className="row-sub">{t('Private')}</p>}
      <div className="hx-external-thread-share-options">
        <label>{t('Sharing')}
          <select aria-label={t('Sharing')} value={audienceType} disabled={busy||audienceLoading||Boolean(audienceError)} onChange={event=>setAudienceType(event.target.value as 'workspace'|'room'|'none')}>
            <option value="workspace">{t('Workspace members')}</option><option value="room">{t('Room')}</option><option value="none">{t('Private')}</option>
          </select>
        </label>
        {audienceType === 'room'&&<label>{t('Room')}
          <select aria-label={t('Room')} value={audienceRoomId} disabled={busy||audienceLoading||Boolean(audienceError)||!audienceRooms.length} onChange={event=>setAudienceRoomId(event.target.value)}>
            {audienceRooms.map(room=><option key={room.id} value={room.id}>{room.name}</option>)}
          </select>
        </label>}
        {audienceType !== 'none'&&<>
          <label>{t('Permission')}
            <select aria-label={`${t('Permission')} · ${t('Sharing')}`} value={audiencePermission} disabled={busy||audienceLoading||Boolean(audienceError)} onChange={event=>setAudiencePermission(event.target.value as 'view'|'edit')}>
              <option value="view">{t('Can view')}</option><option value="edit">{t('Can edit')}</option>
            </select>
          </label>
          <label>{t('Expires')}
            <select aria-label={`${t('Expires')} · ${t('Sharing')}`} value={audienceExpiry} disabled={busy||audienceLoading||Boolean(audienceError)} onChange={event=>setAudienceExpiry(event.target.value as Expiry)}>
              {audience&&<option value="current">{t('Expires')} · {expires(audience.expiresAt)}</option>}
              <option value="7d">{t('In 7 days')}</option><option value="30d">{t('In 30 days')}</option><option value="never">{t('Never')}</option>
            </select>
          </label>
        </>}
      </div>
      {audienceError&&<p className="form-error" role="alert">{audienceError}</p>}
      {audienceConflict&&<button type="button" className="btn-text" disabled={busy} onClick={()=>setAttempt(n=>n+1)}>{t('Reload')}</button>}
      <button type="button" className="pill-btn" disabled={busy||audienceLoading||Boolean(audienceError)||audienceType==='room'&&!audienceRoomId||audienceType==='room'&&!audienceRooms.some(room=>room.id===audienceRoomId)} onClick={()=>void saveAudience()}>
        {busy?t('Saving…'):t('Save')}
      </button>
      {audience&&<button type="button" className="btn-text" disabled={busy||audienceLoading||Boolean(audienceError)} onClick={()=>void saveAudience('none')}>{t('Revoke access')}</button>}
    </section>
    <section className="hx-external-thread-requests" aria-label={t('Guest reply requests')}>
      <h3>{t('Guest reply requests')}</h3>
      <p className="row-sub">{t('View-only guests must be approved before their message is added to this thread or delivered to members.')}</p>
      {loading&&<p role="status">{t('Loading…')}</p>}
      {!loading&&!error&&!sendRequests.length&&<p className="row-sub">{t('No pending guest reply requests.')}</p>}
      {sendRequests.map(request=><article className="hx-external-thread-request" key={request.id} data-request-id={request.id}>
        <div><strong>{request.guest_name||request.guest_email||t('Guest')}</strong>{request.guest_email&&<small>{request.guest_email}</small>}<p>{request.body}</p><small>{new Date(request.requested_at).toLocaleString()}</small></div>
        <div className="hx-external-thread-request-actions"><button type="button" className="pill-btn" disabled={busy} onClick={()=>decideRequest(request,'approve')}>{t('Approve')}</button><button type="button" className="btn-text" disabled={busy} onClick={()=>decideRequest(request,'reject')}>{t('Decline')}</button></div>
      </article>)}
    </section>
    <section className="hx-external-thread-invites" aria-label={t('Invite a guest')}>
      <h3>{t('Anyone with the link')}</h3>
      <p className="row-sub">{t('Anyone who signs in can access only this Thread. They will not join the workspace or its Rooms.')}</p>
      <form className="hx-external-thread-share-form" onSubmit={createLink}>
        <div className="hx-external-thread-share-options">
          <label>{t('Permission')}<select aria-label={t('Link permission')} value={linkPermission} disabled={busy} onChange={event=>setLinkPermission(event.target.value as 'view'|'edit')}><option value="view">{t('Can view')}</option><option value="edit">{t('Can edit')}</option></select></label>
          <label>{t('Expires')}<select aria-label={t('Link expiry')} value={linkExpiry} disabled={busy} onChange={event=>setLinkExpiry(event.target.value as Expiry)}><option value="7d">{t('In 7 days')}</option><option value="30d">{t('In 30 days')}</option><option value="never">{t('Never')}</option></select></label>
        </div>
        <button type="submit" className="pill-btn" disabled={busy}>{busy?t('Saving…'):t('Create share link')}</button>
      </form>
      {publicLink&&<div className="hx-external-thread-invite-link"><label>{t('Copy this share link')}<input readOnly value={publicLink} aria-label={t('Share link')} /></label><button type="button" className="btn-text" onClick={()=>void navigator.clipboard.writeText(publicLink)}>{t('Copy link')}</button></div>}
      <ul className="hx-external-thread-invite-list" aria-label={t('Active share links')}>
        {linkShares.map(link=><li key={link.id}><span><strong>{t(link.permission==='edit'?'Can edit':'Can view')}</strong><small>{t('Expires')} {expires(link.expiresAt)}</small></span><button type="button" className="btn-text" disabled={busy} onClick={()=>revokeLink(link)}>{t('Revoke link')}</button></li>)}
      </ul>
    </section>
    <section className="hx-external-thread-invites" aria-label={t('Invite a guest')}>
      <h3>{t('Invite by link')}</h3>
      <p className="row-sub">{t('The recipient must verify this email address. An email is sent when delivery is configured; a copyable link is always available.')}</p>
      <form className="hx-external-thread-share-form" onSubmit={createInvite}>
        <label>{t('Email address')}
          <input type="email" autoComplete="email" value={inviteEmail} disabled={busy} onChange={event=>setInviteEmail(event.target.value)} placeholder={t('name@example.com')} />
        </label>
        <div className="hx-external-thread-share-options">
          <label>{t('Permission')}
            <select aria-label={t('Invite permission')} value={invitePermission} disabled={busy} onChange={event=>setInvitePermission(event.target.value as 'view'|'edit')}>
              <option value="view">{t('Can view')}</option><option value="edit">{t('Can edit')}</option>
            </select>
          </label>
          <label>{t('Expires')}
            <select aria-label={t('Invite expiry')} value={inviteExpiry} disabled={busy} onChange={event=>setInviteExpiry(event.target.value as Expiry)}>
              <option value="7d">{t('In 7 days')}</option><option value="30d">{t('In 30 days')}</option><option value="never">{t('Never')}</option>
            </select>
          </label>
        </div>
        <button type="submit" className="pill-btn" disabled={busy||!inviteEmail.trim()}>{t('Create invite link')}</button>
      </form>
      {inviteUrl&&<div className="hx-external-thread-invite-link"><p>{t(inviteDelivery==='sent'?'Invitation email sent.':inviteDelivery==='failed'?'Email could not be delivered. Share this link manually.':'Email delivery is not configured. Share this link manually.')}</p><label>{t('Copy this one-time invite link')}<input readOnly value={inviteUrl} aria-label={t('Invite link')} /></label><button type="button" className="btn-text" onClick={()=>void copyInvite()}>{t('Copy link')}</button></div>}
      <ul className="hx-external-thread-invite-list" aria-label={t('Pending invitations')}>
        {invitations.map(invite=><li key={invite.id}><span><strong>{invite.email}</strong><small>{t(invite.permission==='edit'?'Can edit':'Can view')} · {t('Expires')} {expires(invite.expiresAt)}</small></span><button type="button" className="btn-text" disabled={busy} onClick={()=>revokeInvite(invite)}>{t('Revoke invite')}</button></li>)}
      </ul>
    </section>
    <section className="hx-external-thread-grants" aria-label={t('People with access')}>
      <h3>{t('People with access')}</h3>
      {loading&&<p role="status">{t('Loading…')}</p>}
      {!loading&&!error&&!shares.length&&<p className="row-sub">{t('No one outside this workspace has access.')}</p>}
      {shares.map(share=><article className="hx-external-thread-grant" key={share.id} data-share-id={share.id}>
        <div className="hx-external-thread-person"><strong>{share.recipient.name}</strong><span>{share.recipient.email}</span><small>{t('Expires')}: {expires(share.expiresAt)}</small>{share.recipientIsMember&&<small>{t('Workspace member')}</small>}{share.suspended&&<small role="status">{share.recipientIsMember?t('External grant is paused while this person is a workspace member.'):t('External grant stays paused after membership ends until it is revoked or re-shared.')}</small>}</div>
        <label className="hx-external-thread-permission">{t('Permission')}
          <select aria-label={t('Permission for {email}').replace('{email}',share.recipient.email)} value={drafts[share.id]||share.permission} disabled={busy||Boolean(share.suspended||share.recipientIsMember)} onChange={event=>setDrafts(current=>({...current,[share.id]:event.target.value as 'view'|'edit'}))}>
            <option value="view">{t('Can view')}</option><option value="edit">{t('Can edit')}</option>
          </select>
        </label>
        <div className="hx-external-thread-grant-actions">
          <button type="button" className="btn-text" disabled={busy||Boolean(share.suspended||share.recipientIsMember)||(drafts[share.id]||share.permission)===share.permission} onClick={()=>update(share)}>{t('Save')}</button>
          <button type="button" className="btn-text" disabled={busy} onClick={()=>revoke(share)}>{t('Revoke access')}</button>
        </div>
      </article>)}
      {!loading&&error&&<button type="button" className="btn-text" onClick={()=>setAttempt(n=>n+1)}>{t('Retry')}</button>}
    </section>
  </Dialog>
}
