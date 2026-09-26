import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

// Where the audit log streams, under the audit log (docs/audit-log-phase2.md
// §4): the company's SIEM over HTTPS, Splunk HEC or Datadog. Owners add and
// change streams; admins see how far each has got.

interface Stream {
  id: string; kind: 'https' | 'splunk_hec' | 'datadog'; endpoint: string; region: string | null; minSeverity: string
  deliveredSeq: number; status: 'active' | 'paused' | 'failing'; failures: number; lastError: string | null; lastSentAt: string | null; behind: number
}
const KIND_WORD: Record<string, string> = { https: 'HTTPS (signed JSON lines)', splunk_hec: 'Splunk HTTP Event Collector', datadog: 'Datadog logs' }

export const AuditStreams: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const [streams, setStreams] = useState<Stream[] | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [sites, setSites] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ kind: 'https', endpoint: '', secret: '', region: 'us1', minSeverity: 'info' })
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const headers = { 'x-session-token': sessionToken, 'content-type': 'application/json' }

  const load = useCallback(async () => {
    const res = await fetch(`${httpBase}/audit/streams?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
    if (!res.ok) { setStreams(null); return }
    const data = await res.json()
    setStreams(data.streams || []); setCanEdit(data.canEdit === true); setSites(data.datadogSites || [])
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { void load() }, [load])

  const call = async (path: string, method: string, body: Record<string, unknown>, done?: string) => {
    setError(null); setNote(null)
    const res = await fetch(`${httpBase}${path}`, { method, headers, body: JSON.stringify({ orgId, ...body }) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.message || t('That did not work.')); return null }
    if (done) setNote(done)
    if (data.streams) setStreams(data.streams)
    return data
  }

  if (streams === null) return null
  return (
    <div className="audit-streams" data-audit-streams>
      <div className="studio-section-head">
        <div>
          <h2>{t('Streams')}</h2>
          <p>{t('Send the audit log to your SIEM as it is written, in order. If it fails, it retries and carries on from where it stopped.')}</p>
        </div>
        {canEdit && !adding && <button type="button" className="studio-btn primary" onClick={() => setAdding(true)} data-add-stream>{t('Add a stream')}</button>}
      </div>
      {note && <p className="rules-note" role="status">{note}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {adding && (
        <form className="org-key-form" onSubmit={(e) => { e.preventDefault(); void call('/audit/streams', 'POST', form, t('Streaming from now on.')).then((d) => { if (d) setAdding(false) }) }}>
          <select className="rules-number wide" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {Object.entries(KIND_WORD).map(([k, w]) => <option key={k} value={k}>{t(w)}</option>)}
          </select>
          {form.kind !== 'datadog' && <input className="rules-number wide" placeholder={form.kind === 'splunk_hec' ? 'https://splunk.your-company.com:8088' : 'https://siem.your-company.com/honmaru'} value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} />}
          {form.kind === 'datadog' && (
            <select className="rules-number wide" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })}>
              {sites.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <input className="rules-number wide" type="password" autoComplete="off" placeholder={form.kind === 'https' ? t('Signing secret') : form.kind === 'splunk_hec' ? t('HEC token') : t('Datadog API key')} value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
          <select className="rules-number wide" value={form.minSeverity} onChange={(e) => setForm({ ...form, minSeverity: e.target.value })}>
            {['info', 'notice', 'warning', 'critical'].map((s) => <option key={s} value={s}>{t('{severity} and above', { severity: s })}</option>)}
          </select>
          <div className="rules-actions">
            <button type="submit" className="studio-btn primary" disabled={!form.secret.trim() || (form.kind !== 'datadog' && !form.endpoint.trim())}>{t('Save')}</button>
            <button type="button" className="studio-btn" onClick={() => setAdding(false)}>{t('Cancel')}</button>
          </div>
        </form>
      )}
      {streams.map((s) => (
        <div key={s.id} className="sso-domain" data-stream={s.id}>
          <div className="sso-domain-head">
            <b>{t(KIND_WORD[s.kind])}</b>
            <span className={`sso-badge${s.status === 'active' ? ' ok' : ''}`}>{s.status === 'active' ? t('Sending') : s.status === 'paused' ? t('Paused') : t('Failing')}</span>
          </div>
          <span className="row-sub">{s.kind === 'datadog' ? s.region : s.endpoint} · {s.behind ? t('{n} entries waiting', { n: s.behind }) : t('Up to date')}{s.lastError ? ` · ${s.lastError}` : ''}</span>
          {canEdit && (
            <div className="rules-actions">
              <button type="button" className="studio-btn" onClick={() => void call(`/audit/streams/${s.id}/test`, 'POST', {}, t('A test event was sent.'))}>{t('Send a test')}</button>
              <button type="button" className="studio-btn" onClick={() => void call(`/audit/streams/${s.id}`, 'PUT', { paused: s.status !== 'paused' })}>{s.status === 'paused' ? t('Resume') : t('Pause')}</button>
              <button type="button" className="studio-btn" onClick={() => { const from = window.prompt(t('Send again from which entry number?'), '1'); if (from) void call(`/audit/streams/${s.id}/replay`, 'POST', { fromSeq: Number(from) }, t('It will send again from there.')) }}>{t('Send again from…')}</button>
              <button type="button" className="studio-btn danger" onClick={() => void call(`/audit/streams/${s.id}`, 'DELETE', {})}>{t('Remove')}</button>
            </div>
          )}
        </div>
      ))}
      {!canEdit && <p className="form-note">{t('An owner of this workspace can change these.')}</p>}
    </div>
  )
}
