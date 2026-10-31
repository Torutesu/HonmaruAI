import React, { useCallback, useEffect, useState } from 'react'
import type { HarnessApi, SkillShareLink } from '../utils/harness'
import { useT } from '../utils/i18n'

export function SkillSharing({ api, skillId }: { api: HarnessApi; skillId: string }) {
  const t = useT()
  const [shares, setShares] = useState<SkillShareLink[]>([])
  const [expiresInDays, setExpiresInDays] = useState(7)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [link, setLink] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')

  const reload = useCallback(async () => setShares((await api.skillShares(skillId)).shares), [api, skillId])
  useEffect(() => { let live = true; setError(''); void reload().catch(err => { if (live) setError(err instanceof Error ? err.message : String(err)) }); return () => { live = false } }, [reload])

  const create = async () => {
    setBusy(true); setError(''); setNotice(''); setLink(''); setDownloadUrl('')
    try {
      const made = await api.createSkillShare(skillId, expiresInDays)
      const token = made.token
      const next = `${location.origin}/#/skill-share/${encodeURIComponent(token)}`
      setLink(next)
      setDownloadUrl(`${api.httpBase}/skill-shares/${encodeURIComponent(token)}/download`)
      try { await navigator.clipboard?.writeText(next); setNotice(t('Skill share link copied. Save it before closing this panel; the token cannot be shown again.')) }
      catch { setNotice(t('Copy this Skill link before closing this panel; the token cannot be shown again.')) }
      await reload()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const revoke = async (share: SkillShareLink) => {
    setBusy(true); setError(''); setNotice('')
    try { await api.revokeSkillShare(skillId, share.id); setNotice(t('Skill share link revoked.')); await reload() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setNotice(t('Skill share link copied.')) }
    catch { setNotice(t('Select and copy the Skill link.')) }
  }
  const active = (share: SkillShareLink) => !share.revokedAt && Date.parse(share.expiresAt) > Date.now()

  return <section className="hx-skill-sharing" aria-label={t('Share Skill by link')}>
    <div className="rows-title">{t('Share Skill by link')}</div>
    <p className="hx-hint">{t('Anyone with the link can inspect the Skill metadata and download its ZIP until the link expires or is revoked. Importing creates a new private copy. The link contains the Skill instructions and support files.')}</p>
    {error && <div className="form-error" role="alert">{error}</div>}
    {notice && <div className="form-note" role="status">{notice}</div>}
    <div className="row static">
      <span className="row-main">
        <label className="hx-skill-share-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><span>{t('I understand anyone with this link can download the complete Skill package until it expires or is revoked.')}</span></label>
        <label className="hx-skill-share-expiry">{t('Link expires in')}<select aria-label={t('Skill share expiry')} value={expiresInDays} disabled={busy} onChange={event => setExpiresInDays(Number(event.target.value))}>
          {[1, 7, 30, 90].map(days => <option key={days} value={days}>{t('{n} days', { n: days })}</option>)}
        </select></label>
        <button className="pill-btn" disabled={busy || !confirmed} onClick={() => void create()}>{busy ? t('Working…') : t('Create Skill link')}</button>
      </span>
    </div>
    {link && <div className="row static hx-skill-share-link-row">
      <input className="hx-cell-input" aria-label={t('Skill share link')} readOnly value={link} onFocus={event => event.currentTarget.select()} />
      <button className="pill-btn quiet" onClick={() => void copy()}>{t('Copy link')}</button>
      <a className="pill-btn quiet" href={downloadUrl}>{t('Download ZIP')}</a>
    </div>}
    <div className="rows-title">{t('Active and past Skill links')}</div>
    {shares.length === 0 ? <p className="hx-hint">{t('No Skill share links yet.')}</p> : <div className="rows">
      {shares.map(share => <div className="row static" key={share.id}>
        <span className="row-main">{t('{n} files · {size} bytes', { n: share.fileCount, size: share.totalBytes })}<span className="row-sub">{active(share) ? t('Expires {date}', { date: new Date(share.expiresAt).toLocaleString() }) : share.revokedAt ? t('Revoked') : t('Expired')} · {new Date(share.createdAt).toLocaleDateString()}</span></span>
        {active(share) && <button className="btn-text danger" disabled={busy} onClick={() => void revoke(share)}>{t('Revoke')}</button>}
      </div>)}
    </div>}
  </section>
}
