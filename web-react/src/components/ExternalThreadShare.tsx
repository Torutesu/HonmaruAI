import React, { useEffect, useMemo, useState } from 'react'
import { Dialog } from './Dialog'
import { useT } from '../utils/i18n'
import {
  ExternalThreadShareError,
  listExternalThreadShares,
  revokeExternalThreadShare,
  shareExternalThread,
  type ExternalThreadGrant,
} from '../utils/externalThreadSharing'
import './ExternalThreadShare.css'

type Api = { httpBase: string; orgId: string; sessionToken: string }
type Expiry = '7d' | '30d' | 'never'
const expiryMs: Record<Exclude<Expiry, 'never'>, number> = { '7d': 7 * 86400000, '30d': 30 * 86400000 }
function nextExpiry(value: Expiry) {
  return value === 'never' ? null : new Date(Date.now() + expiryMs[value]).toISOString()
}
function errorText(error: unknown, t: (text: string) => string) {
  if (error instanceof ExternalThreadShareError && error.status === 404) return t('An existing verified account outside this workspace is required.')
  return t('Access could not be updated. Check the connection and your permission, then try again.')
}

export function ExternalThreadShare({ api, threadId, onClose }: { api: Api; threadId: string; onClose: () => void }) {
  const t = useT()
  const [shares, setShares] = useState<ExternalThreadGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [email, setEmail] = useState('')
  const [permission, setPermission] = useState<'view'|'edit'>('view')
  const [expiry, setExpiry] = useState<Expiry>('7d')
  const [drafts, setDrafts] = useState<Record<string, 'view'|'edit'>>({})
  const apiKey = useMemo(() => ({ ...api }), [api.httpBase, api.orgId, api.sessionToken])
  useEffect(() => {
    const controller = new AbortController()
    let live = true
    setLoading(true); setError('')
    void listExternalThreadShares(apiKey, threadId, controller.signal)
      .then(value => { if (live) { setShares(value); setDrafts(Object.fromEntries(value.map(item => [item.id,item.permission]))) } })
      .catch(err => { if (live && !controller.signal.aborted) setError(errorText(err,t)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false; controller.abort() }
  }, [apiKey, threadId, attempt])

  const mutate = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action(); setAttempt(n => n + 1) }
    catch (err) { setError(errorText(err,t)) }
    finally { setBusy(false) }
  }
  const add = (event: React.FormEvent) => {
    event.preventDefault()
    const value = email.trim()
    if (!value) return
    void mutate(async () => {
      await shareExternalThread(apiKey,threadId,{email:value,permission,expiresAt:nextExpiry(expiry)})
      setEmail('')
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
    await revokeExternalThreadShare(apiKey,threadId,share.recipient.email)
  })
  const expires = (value: string | null) => value ? new Date(value).toLocaleString() : t('No expiry')

  return <Dialog
    title={t('Share thread with people')}
    lede={t('Only these people can open this thread. Sharing never adds workspace membership.')}
    onClose={onClose}
    className="hx-external-thread-share"
    footer={<button type="button" className="pill-btn" onClick={onClose}>{t('Done')}</button>}
  >
    <form className="hx-external-thread-share-form" onSubmit={add}>
      <label>{t('Email address')}
        <input type="email" autoComplete="email" value={email} disabled={busy} onChange={event=>setEmail(event.target.value)} placeholder={t('name@example.com')} />
      </label>
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
      <button type="submit" className="pill-btn" disabled={busy||!email.trim()}>{busy?t('Saving…'):t('Share thread')}</button>
    </form>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <section className="hx-external-thread-grants" aria-label={t('People with access')}>
      <h3>{t('People with access')}</h3>
      {loading&&<p role="status">{t('Loading…')}</p>}
      {!loading&&!error&&!shares.length&&<p className="row-sub">{t('No one outside this workspace has access.')}</p>}
      {shares.map(share=><article className="hx-external-thread-grant" key={share.id} data-share-id={share.id}>
        <div className="hx-external-thread-person"><strong>{share.recipient.name}</strong><span>{share.recipient.email}</span><small>{t('Expires')}: {expires(share.expiresAt)}</small></div>
        <label className="hx-external-thread-permission">{t('Permission')}
          <select aria-label={t('Permission for {email}').replace('{email}',share.recipient.email)} value={drafts[share.id]||share.permission} disabled={busy} onChange={event=>setDrafts(current=>({...current,[share.id]:event.target.value as 'view'|'edit'}))}>
            <option value="view">{t('Can view')}</option><option value="edit">{t('Can edit')}</option>
          </select>
        </label>
        <div className="hx-external-thread-grant-actions">
          <button type="button" className="btn-text" disabled={busy||(drafts[share.id]||share.permission)===share.permission} onClick={()=>update(share)}>{t('Save')}</button>
          <button type="button" className="btn-text" disabled={busy} onClick={()=>revoke(share)}>{t('Revoke access')}</button>
        </div>
      </article>)}
      {!loading&&error&&<button type="button" className="btn-text" onClick={()=>setAttempt(n=>n+1)}>{t('Retry')}</button>}
    </section>
  </Dialog>
}
