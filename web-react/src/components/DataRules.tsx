import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

// Data rules, in the Studio (docs/enterprise-audit-log.md §10): what this
// workspace does not want said in it. A built-in detector, a pattern of your
// own or a list of words; each warns or blocks. Admins change them; what a
// rule found is never kept, only that it did.

interface Rule { id: string; name: string; kind: 'builtin' | 'regex' | 'keywords'; detector: string | null; pattern: string | null; keywords: string[] | null; action: 'warn' | 'block'; enabled: boolean }
interface Detector { id: string; name: string }

export const DataRules: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [detectors, setDetectors] = useState<Detector[]>([])
  const [canEdit, setCanEdit] = useState(false)
  const [denied, setDenied] = useState(false)
  const [form, setForm] = useState({ kind: 'builtin' as Rule['kind'], detector: 'my_number', name: '', pattern: '', keywords: '', action: 'warn' as Rule['action'] })
  const [trial, setTrial] = useState('')
  const [hits, setHits] = useState<string[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headers = { 'x-session-token': sessionToken, 'content-type': 'application/json' }

  const load = useCallback(async () => {
    const res = await fetch(`${httpBase}/orgs/dlp?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } }).catch(() => null)
    if (res?.status === 403) { setDenied(true); return }
    const data = res?.ok ? await res.json().catch(() => null) : null
    if (!data) return
    setRules(data.rules); setDetectors(data.detectors); setCanEdit(Boolean(data.canEdit))
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { void load() }, [load])

  const send = async (path: string, method: string, body: Record<string, unknown>, done?: string) => {
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await fetch(`${httpBase}${path}${method === 'DELETE' ? `?orgId=${encodeURIComponent(orgId)}` : ''}`, { method, headers, ...(method === 'DELETE' ? {} : { body: JSON.stringify({ orgId, ...body }) }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return null }
      if (done) setNote(done)
      await load()
      return data
    } finally { setBusy(false) }
  }
  const add = async () => {
    const body: Record<string, unknown> = { kind: form.kind, action: form.action, name: form.name.trim() || undefined }
    if (form.kind === 'builtin') body.detector = form.detector
    if (form.kind === 'regex') body.pattern = form.pattern
    if (form.kind === 'keywords') body.keywords = form.keywords
    const made = await send('/orgs/dlp', 'POST', body, t('The rule is on.'))
    if (made) setForm({ ...form, name: '', pattern: '', keywords: '' })
  }
  const test = async () => {
    const res = await fetch(`${httpBase}/orgs/dlp/test`, { method: 'POST', headers, body: JSON.stringify({ orgId, text: trial }) }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    setHits(data ? (data.hits as Array<{ name: string }>).map((h) => h.name) : [])
  }
  const describe = (r: Rule) => (r.kind === 'builtin' ? t('Built in') : r.kind === 'regex' ? r.pattern : (r.keywords || []).join(', '))

  if (denied) return <section className="studio-page" data-studio-page="dlp"><h1 className="studio-title">{t('Data rules')}</h1><p className="studio-lede">{t('Only an admin can see these rules.')}</p></section>

  return (
    <section className="studio-page sso-page" data-studio-page="dlp">
      <h1 className="studio-title">{t('Data rules')}</h1>
      <p className="studio-lede">{t('Catch what should not be said here — a My Number, a card number, a secret key, words of your own — before it is sent. A rule warns, and the person may send anyway, or blocks. What was found is never kept; the audit log says only which rule.')}</p>
      {note && <p className="rules-note" role="status">{note}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      {(rules || []).map((r) => (
        <div key={r.id} className="sso-domain" data-dlp-rule={r.name}>
          <div className="sso-domain-head">
            <b>{r.name}</b>
            <span className={`sso-badge${r.enabled ? ' ok' : ''}`}>{!r.enabled ? t('Off') : r.action === 'block' ? t('Blocks') : t('Warns')}</span>
          </div>
          <p className="row-sub"><code>{describe(r)}</code></p>
          {canEdit && (
            <div className="rules-actions">
              <select className="rules-number" value={r.action} disabled={busy} onChange={(e) => void send(`/orgs/dlp/${r.id}`, 'PATCH', { action: e.target.value }, t('Saved.'))}>
                <option value="warn">{t('Warn')}</option>
                <option value="block">{t('Block')}</option>
              </select>
              <button type="button" className="studio-btn" disabled={busy} onClick={() => void send(`/orgs/dlp/${r.id}`, 'PATCH', { enabled: !r.enabled })}>{r.enabled ? t('Turn off') : t('Turn on')}</button>
              <button type="button" className="studio-btn danger" disabled={busy} onClick={() => void send(`/orgs/dlp/${r.id}`, 'DELETE', {})}>{t('Remove')}</button>
            </div>
          )}
        </div>
      ))}
      {rules && !rules.length && <p className="row-sub">{t('No rules yet: everything is sent as written.')}</p>}

      {canEdit && (
        <>
          <div className="studio-section-head"><div><h2>{t('Add a rule')}</h2></div></div>
          <form className="sso-domain" data-dlp-add onSubmit={(e) => { e.preventDefault(); void add() }}>
            <div className="rules-actions">
              <select className="rules-number" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Rule['kind'] })} data-dlp-kind>
                <option value="builtin">{t('Built in')}</option>
                <option value="regex">{t('A pattern')}</option>
                <option value="keywords">{t('Words')}</option>
              </select>
              {form.kind === 'builtin' && (
                <select className="rules-number" value={form.detector} onChange={(e) => setForm({ ...form, detector: e.target.value })} data-dlp-detector>
                  {detectors.map((d) => <option key={d.id} value={d.id}>{t(d.name)}</option>)}
                </select>
              )}
              <select className="rules-number" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value as Rule['action'] })} data-dlp-action>
                <option value="warn">{t('Warn')}</option>
                <option value="block">{t('Block')}</option>
              </select>
            </div>
            {form.kind !== 'builtin' && <input className="rules-number wide" placeholder={t('Name, e.g. Project names')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-dlp-name />}
            {form.kind === 'regex' && <input className="rules-number wide" placeholder="PRJ-\d{4}" value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} data-dlp-pattern />}
            {form.kind === 'keywords' && <textarea className="rules-number wide" rows={3} placeholder={t('One per line, or separated by commas')} value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} data-dlp-keywords />}
            <div className="rules-actions">
              <button type="submit" className="studio-btn primary" disabled={busy || (form.kind === 'regex' && !form.pattern.trim()) || (form.kind === 'keywords' && !form.keywords.trim())}>{t('Add rule')}</button>
            </div>
          </form>
        </>
      )}
      {!canEdit && rules && <p className="form-note">{t('An admin of this workspace can change these.')}</p>}

      <div className="studio-section-head"><div><h2>{t('Try it')}</h2><p>{t('Paste some text to see which rules it would meet. Nothing here is sent or kept.')}</p></div></div>
      <form className="sso-domain" onSubmit={(e) => { e.preventDefault(); void test() }}>
        <textarea className="rules-number wide" rows={3} value={trial} onChange={(e) => { setTrial(e.target.value); setHits(null) }} data-dlp-trial />
        <div className="rules-actions">
          <button type="submit" className="studio-btn" disabled={!trial.trim()}>{t('Check')}</button>
          {hits && <span className="row-sub" data-dlp-hits>{hits.length ? t('Meets: {rules}', { rules: hits.join(', ') }) : t('Meets no rule.')}</span>}
        </div>
      </form>
    </section>
  )
}
