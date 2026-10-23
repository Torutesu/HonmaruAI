import React, { useEffect, useState } from 'react'
import { harnessApi, type Followup } from '../utils/harness'
import { useT } from '../utils/i18n'

export function AgentFollowups({ api, agentId }: { api: ReturnType<typeof harnessApi>; agentId: string }) {
  const t = useT()
  const [status, setStatus] = useState('scheduled')
  const [items, setItems] = useState<Followup[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let live = true
    setItems(null); setError('')
    api.followups(undefined, status, agentId).then(result => {
      if (live) setItems(result.followups.filter(item => item.agentId === agentId))
    }).catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [api, agentId, status, refresh])
  const labels: Record<string, string> = { scheduled: 'Scheduled', running: 'Running', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }
  return <section aria-label={t('Follow-ups')}>
    <div className="playbook-add-foot"><select aria-label={t('Follow-up status')} value={status} disabled={busy} onChange={e => setStatus(e.target.value)}>
      {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
    </select><button className="btn-text" disabled={busy} onClick={() => setRefresh(n => n + 1)}>{t('Refresh')}</button></div>
    {error && <p role="alert">{t(error)}</p>}
    {!items && !error && <p role="status">{t('Loading…')}</p>}
    {items?.length === 0 && <p className="row-sub">{t('No follow-ups with this status.')}</p>}
    <div className="rows">{items?.map(item => <div key={item.id} className="row static">
      <div className="row-main">{item.instruction}<span className="row-sub">{item.channel.replace(/^b:/, '#')} · {new Date(item.dueAt).toLocaleString()} · {t(labels[item.status] || item.status)}</span>
        {item.result && <details className="hx-run-detail"><summary>{t(item.status === 'failed' ? 'Error' : 'Output')}</summary><pre>{item.result}</pre>{item.doneAt && <time dateTime={item.doneAt}>{new Date(item.doneAt).toLocaleString()}</time>}</details>}
      </div>
      {item.status === 'scheduled' && <button className="btn-text" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try { await api.cancelFollowup(item.id); setRefresh(n => n + 1) }
        catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        finally { setBusy(false) }
      }}>{t('Cancel')}</button>}
    </div>)}</div>
  </section>
}
