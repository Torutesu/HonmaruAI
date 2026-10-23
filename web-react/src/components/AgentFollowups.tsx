import React, { useEffect, useRef, useState } from 'react'
import { harnessApi, type Followup } from '../utils/harness'
import { useT } from '../utils/i18n'
import { hashForThread } from '../utils/route'

export function AgentFollowups({ api, agentId }: { api: ReturnType<typeof harnessApi>; agentId: string }) {
  const t = useT()
  const [status, setStatus] = useState('scheduled')
  const [items, setItems] = useState<Followup[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [pageBusy, setPageBusy] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    const version = ++generation.current
    let live = true
    setItems(null); setError(''); setNextCursor(null); setPageBusy(false)
    api.followupHistory(agentId, status).then(result => {
      if (live && version === generation.current) { setItems(result.followups.filter(item => item.agentId === agentId)); setNextCursor(result.nextCursor) }
    }).catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false; ++generation.current }
  }, [api, agentId, status, refresh])
  const labels: Record<string, string> = { all: 'All', scheduled: 'Scheduled', running: 'Running', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }
  return <section aria-label={t('Follow-ups')}>
    <div className="playbook-add-foot"><select aria-label={t('Follow-up status')} value={status} disabled={busy} onChange={e => setStatus(e.target.value)}>
      {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
    </select><button className="btn-text" disabled={busy} onClick={() => setRefresh(n => n + 1)}>{t('Refresh')}</button></div>
    {error && <p role="alert">{t(error)}</p>}
    {!items && !error && <p role="status">{t('Loading…')}</p>}
    {items?.length === 0 && <p className="row-sub">{t('No follow-ups with this status.')}</p>}
    <div className="rows">{items?.map(item => <div key={item.id} className="row static">
      <div className="row-main">{item.instruction}<span className="row-sub">{item.channel.replace(/^b:/, '#')} · {new Date(item.dueAt).toLocaleString()} · {t(labels[item.status] || item.status)}</span>
        {item.threadId && <a className="btn-text" href={hashForThread(item.threadId, api.orgId)}>{t('View conversation')}</a>}
        {item.result && <details className="hx-run-detail"><summary>{t(item.status === 'failed' ? 'Error' : 'Output')}</summary><pre>{item.result}</pre>{item.doneAt && <time dateTime={item.doneAt}>{new Date(item.doneAt).toLocaleString()}</time>}</details>}
      </div>
      {item.status === 'scheduled' && <button className="btn-text" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try { await api.cancelFollowup(item.id); setRefresh(n => n + 1) }
        catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        finally { setBusy(false) }
      }}>{t('Cancel')}</button>}
    </div>)}</div>
    {nextCursor && <button className="btn-text" disabled={busy || pageBusy} onClick={async () => {
      const version = generation.current
      setPageBusy(true); setError('')
      try {
        const result = await api.followupHistory(agentId, status, nextCursor)
        if (version !== generation.current) return
        setItems(current => [...new Map([...(current || []), ...result.followups.filter(item => item.agentId === agentId)].map(item => [item.id, item])).values()])
        setNextCursor(result.nextCursor)
      } catch (e) { if (version === generation.current) setError(e instanceof Error ? e.message : String(e)) }
      finally { if (version === generation.current) setPageBusy(false) }
    }}>{t(pageBusy ? 'Loading…' : 'Load more')}</button>}
  </section>
}
