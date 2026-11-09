import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryPromotionRequest } from '../utils/harness'
import { useT } from '../utils/i18n'

type Page = { canDecide: boolean; requests: MemoryPromotionRequest[] }
export function AgentMemoryPromotions({ load, decide, refreshKey = 0 }: {
  load: () => Promise<Page>
  decide: (id: string, action: 'approve' | 'reject') => Promise<unknown>
  refreshKey?: number
}) {
  const t = useT()
  const [requests, setRequests] = useState<MemoryPromotionRequest[] | null>(null)
  const [canDecide, setCanDecide] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const loadRef = useRef(load)
  const generation = useRef(0)
  loadRef.current = load
  const refresh = useCallback(async () => {
    const current = ++generation.current
    setRequests(null); setCanDecide(false); setError('')
    try {
      const page = await loadRef.current()
      if (current === generation.current) { setRequests(page.requests); setCanDecide(page.canDecide) }
    } catch (reason) {
      if (current === generation.current) { setRequests(null); setCanDecide(false); setError(reason instanceof Error ? reason.message : String(reason)) }
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh, refreshKey])
  const act = async (request: MemoryPromotionRequest, action: 'approve' | 'reject') => {
    setBusy(request.id); setError('')
    try { await decide(request.id, action); await refresh() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy('') }
  }
  return <section className="hx-profile-card hx-memory-promotions" aria-label={t('Personal memory sharing requests')}>
    <header><span>{t('Personal memory sharing requests')}</span><button type="button" className="btn-text" onClick={() => void refresh()}>{t('Refresh')}</button></header>
    <p className="row-sub">{t('A request creates a separate shared copy after approval. The personal source stays private.')}</p>
    {error && <p className="dlg-error" role="alert">{error}</p>}
    {requests === null ? <p role="status">{t('Loading…')}</p> : requests.length === 0 ? <p className="empty">{t('No memory sharing requests.')}</p> : requests.map(request => <article className="hx-memory-promotion" key={request.id}>
      <div className="row-main">
        <strong>{t('Personal memory request')}</strong>
        <span className="row-sub">{t('Source: private memory {id}, version {version}', { id: request.memoryId, version: request.sourceVersion })}</span>
        {request.sourceAccess && request.sourceCurrent && request.source ? <details className="hx-run-detail" open={canDecide && request.status === 'pending'}>
          <summary>{t('Source memory details')} · {t('Current version {version}', { version: request.source.version })}</summary>
          {request.source.title && <strong>{request.source.title}</strong>}
          {request.source.description && <p className="row-sub">{request.source.description}</p>}
          <p className="memory-text">{request.source.body}</p>
        </details> : request.status === 'pending' && <span className="row-sub" role="status">{t('Stale')}: {t('Source changed or access was removed. Approval is disabled; ask for a new request.')}</span>}
        <span className="row-sub">{t('Requested by {name}', { name: request.requesterLogin })} · {new Date(request.createdAt).toLocaleString()}</span>
        <span className="row-sub">{t('Status')}: {t(request.status)}</span>
        {request.decidedAt && <span className="row-sub">{t('Decision by {name}', { name: request.decidedBy || t('workspace reviewer') })} · {new Date(request.decidedAt).toLocaleString()}</span>}
        {request.sharedMemoryId && <span className="row-sub">{t('Shared copy ID')}: <code>{request.sharedMemoryId}</code></span>}
      </div>
      {request.status === 'pending' && canDecide && <div className="hx-memory-actions">
        <button type="button" className="btn-text" disabled={busy !== '' || !request.sourceAccess || !request.sourceCurrent || !request.source} onClick={() => void act(request, 'approve')}>{busy === request.id ? t('Working…') : t('Approve shared copy')}</button>
        <button type="button" className="btn-text danger" disabled={busy !== ''} onClick={() => void act(request, 'reject')}>{t('Reject')}</button>
      </div>}
    </article>)}
  </section>
}
