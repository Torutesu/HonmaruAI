import React, { useCallback, useEffect, useState } from 'react'
import type { HarnessApi, TemplateShare } from '../utils/harness'
import { useT } from '../utils/i18n'

export function TemplateSharing({ api, appId, appVersion }: { api: HarnessApi; appId: string; appVersion: number }) {
  const t = useT()
  const [shares, setShares] = useState<TemplateShare[]>([])
  const [versions, setVersions] = useState<Array<{ version: number; note: string | null; createdAt: string }>>([])
  const [version, setVersion] = useState(String(appVersion))
  const [expiresInDays, setExpiresInDays] = useState(7)
  const [reviewed, setReviewed] = useState(false)
  const [canManage, setCanManage] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [link, setLink] = useState('')
  const [notice, setNotice] = useState('')

  const reload = useCallback(async () => {
    const [shareState, history] = await Promise.all([api.templateShares(appId), api.versions(appId)])
    setShares(shareState.shares)
    setCanManage(shareState.canManage)
    setVersions(history.versions)
    setVersion(current => history.versions.some(item => String(item.version) === current) ? current : String(appVersion))
  }, [api, appId, appVersion])
  useEffect(() => { let live = true; setError(''); void reload().catch(err => { if (live) setError(err instanceof Error ? err.message : String(err)) }); return () => { live = false } }, [reload])

  const create = async () => {
    setBusy(true); setError(''); setNotice(''); setLink('')
    try {
      const made = await api.createTemplateShare(appId, Number(version), expiresInDays)
      const next = `${location.origin}/#/template-share/${encodeURIComponent(made.token)}`
      setLink(next)
      try { await navigator.clipboard?.writeText(next); setNotice(t('Template link copied.')) } catch { setNotice(t('Copy this link before closing this panel.')) }
      await reload()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const revoke = async (share: TemplateShare) => {
    setBusy(true); setError(''); setNotice('')
    try { await api.revokeTemplateShare(appId, share.id); setNotice(t('Template link revoked.')); await reload() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setNotice(t('Template link copied.')) }
    catch { setNotice(t('Select and copy the link.')) }
  }
  const active = (share: TemplateShare) => !share.revokedAt && Date.parse(share.expiresAt) > Date.now()

  return <section className="hx-template-sharing" aria-label={t('Share as a template')}>
    <div className="rows-title">{t('Share as a template')}</div>
    <p className="hx-hint">{t('The link includes the app name, table and field labels, select options, and views. Records, descriptions, custom code, connections and credentials are excluded.')}</p>
    {error && <div className="form-error" role="alert">{error}</div>}
    {notice && <div className="form-note" role="status">{notice}</div>}
    {canManage && <>
      <div className="row static">
        <span className="row-main">
          <label className="hx-template-review"><input type="checkbox" checked={reviewed} disabled={busy} onChange={event => setReviewed(event.target.checked)} /><span>{t('I checked the app name, field labels, select options and view names for sensitive information.')}</span></label>
          <label>{t('Version')}<select aria-label={t('Template version')} value={version} disabled={busy} onChange={event => setVersion(event.target.value)}>
            {versions.map(item => <option key={item.version} value={item.version}>{t('Version {n}', { n: item.version })}{item.note ? ` · ${item.note}` : ''}</option>)}
          </select></label>
          <label>{t('Expires in')}<select aria-label={t('Link expiry')} value={expiresInDays} disabled={busy} onChange={event => setExpiresInDays(Number(event.target.value))}>
            {[1, 7, 30, 90].map(days => <option key={days} value={days}>{t('{n} days', { n: days })}</option>)}
          </select></label>
          <button className="pill-btn" disabled={busy || !versions.length || !reviewed} onClick={() => void create()}>{busy ? t('Working…') : t('Create template link')}</button>
        </span>
      </div>
      {link && <div className="row static hx-template-link-row">
        <input className="hx-cell-input" aria-label={t('Template link')} readOnly value={link} onFocus={event => event.currentTarget.select()} />
        <button className="pill-btn quiet" onClick={() => void copy()}>{t('Copy link')}</button>
      </div>}
      <div className="rows-title">{t('Template links')}</div>
      {shares.length === 0 ? <p className="hx-hint">{t('No template links yet.')}</p> : <div className="rows">
        {shares.map(share => <div className="row static" key={share.id}>
          <span className="row-main">{t('Version {n}', { n: share.appVersion })}<span className="row-sub">{active(share) ? t('Expires {date}', { date: new Date(share.expiresAt).toLocaleString() }) : share.revokedAt ? t('Revoked') : t('Expired')} · {new Date(share.createdAt).toLocaleDateString()}</span></span>
          {active(share) && <button className="btn-text danger" disabled={busy} onClick={() => void revoke(share)}>{t('Revoke')}</button>}
        </div>)}
      </div>}
    </>}
  </section>
}
