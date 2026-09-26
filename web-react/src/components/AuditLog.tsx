import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'

// The audit log, in the Studio: who did what, to what, from where — for an
// admin to look back on, narrow down, and download. What was said is never
// in it; only that something was done, by whom.

interface Party { type: string; name: string | null; ref?: string | null; id?: string }
export interface AuditEntry {
  id: string; seq: number; date_create: number; action: string; category: string
  severity: 'info' | 'notice' | 'warning' | 'critical'; outcome: 'success' | 'denied' | 'failure'
  actor: Party | null; entity: Party | null
  context: { country: string | null; client: string | null; ip_address: string | null }
  details: Record<string, unknown> | null; text: string
}
interface Member { ref: string; name: string }

const CATEGORIES = ['auth', 'membership', 'workspace', 'channel', 'integration', 'data', 'audit', 'security'] as const
const CATEGORY_WORD: Record<string, string> = {
  auth: 'Sign-ins', membership: 'People and invitations', workspace: 'Workspace settings', channel: 'Channels',
  integration: 'API keys and webhooks', data: 'Data', audit: 'The audit log', security: 'Refused',
}

/// An entry as a sentence: "Toru renamed the workspace".
export function describeEntry(entry: AuditEntry, t: ReturnType<typeof useT>): string {
  const actor = entry.actor?.name || (entry.actor?.type === 'system' ? t('Honmaru') : t('Someone'))
  const entity = entry.entity?.name || entry.entity?.id || ''
  return t(entry.text, { actor, entity })
}

export const AuditLog: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [cursor, setCursor] = useState('')
  const [denied, setDenied] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [category, setCategory] = useState('')
  const [severity, setSeverity] = useState('')
  const [actor, setActor] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headers = useMemo(() => ({ 'x-session-token': sessionToken }), [sessionToken])

  const query = useCallback((extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ orgId, limit: '100' })
    if (category) q.set('category', category)
    if (severity) q.set('severity', severity)
    if (actor) q.set('actor', actor)
    if (from) q.set('oldest', new Date(`${from}T00:00:00`).toISOString())
    if (to) q.set('latest', new Date(`${to}T23:59:59`).toISOString())
    for (const [k, v] of Object.entries(extra)) q.set(k, v)
    return q.toString()
  }, [orgId, category, severity, actor, from, to])

  const load = useCallback(async (more = false) => {
    setBusy(true)
    try {
      const res = await fetch(`${httpBase}/audit/logs?${query(more && cursor ? { cursor } : {})}`, { headers })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setDenied(res.status === 403 ? t('Only an admin can read the audit log.') : (data.message || t('That did not work. Try again in a moment.'))); setEntries([]); return }
      setDenied(null)
      setEntries((cur) => (more ? [...(cur || []), ...(data.entries || [])] : (data.entries || [])))
      setCursor(data.response_metadata?.next_cursor || '')
    } finally { setBusy(false) }
  }, [httpBase, headers, query, cursor, t])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(false) }, [httpBase, orgId, category, severity, actor, from, to])
  useEffect(() => {
    fetch(`${httpBase}/members?orgId=${encodeURIComponent(orgId)}`, { headers })
      .then((r) => r.json()).then((d) => setMembers(d.members || [])).catch(() => {})
  }, [httpBase, orgId, headers])

  const download = async (format: 'csv' | 'jsonl') => {
    const res = await fetch(`${httpBase}/audit/logs?${query({ format })}`, { headers })
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.${format}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const when = (s: number) => new Date(s * 1000).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <section className="studio-page audit-page" data-studio-page="audit">
      <h1 className="studio-title">{t('Audit log')}</h1>
      <p className="studio-lede">{t('audit.lede')}</p>
      {denied && <div className="form-note audit-denied">{denied}</div>}
      {!denied && (
        <>
          <div className="audit-filters">
            <label>
              <span>{t('What')}</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} data-audit-filter="category">
                <option value="">{t('Everything')}</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{t(CATEGORY_WORD[c])}</option>)}
              </select>
            </label>
            <label>
              <span>{t('How much it matters')}</span>
              <select value={severity} onChange={(e) => setSeverity(e.target.value)} data-audit-filter="severity">
                <option value="">{t('Everything')}</option>
                <option value="notice">{t('Notable and up')}</option>
                <option value="warning">{t('Warnings and up')}</option>
                <option value="critical">{t('Critical only')}</option>
              </select>
            </label>
            <label>
              <span>{t('Who')}</span>
              <select value={actor} onChange={(e) => setActor(e.target.value)} data-audit-filter="actor">
                <option value="">{t('Anyone')}</option>
                {members.map((m) => <option key={m.ref} value={m.ref}>{m.name}</option>)}
              </select>
            </label>
            <label>
              <span>{t('From')}</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              <span>{t('To')}</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <span className="audit-export">
              <button type="button" className="studio-btn" onClick={() => void download('csv')} data-audit-export="csv"><Icon name="download" size={14} /> CSV</button>
              <button type="button" className="studio-btn" onClick={() => void download('jsonl')}><Icon name="download" size={14} /> JSONL</button>
            </span>
          </div>
          {entries === null && <div className="empty">{t('Loading…')}</div>}
          {entries && entries.length === 0 && <p className="studio-empty">{t('Nothing recorded for these filters.')}</p>}
          <div className="audit-list" role="list">
            {(entries || []).map((e) => (
              <div key={e.id} role="listitem" className={`audit-row sev-${e.severity}${e.outcome !== 'success' ? ' refused' : ''}`} data-audit-action={e.action}>
                <button type="button" className="audit-row-head" aria-expanded={open === e.id} onClick={() => setOpen((o) => (o === e.id ? null : e.id))}>
                  <span className="audit-when">{when(e.date_create)}</span>
                  <span className="audit-text">{describeEntry(e, t)}{e.outcome !== 'success' && <i className="audit-outcome">{t(e.outcome === 'denied' ? 'refused' : 'failed')}</i>}</span>
                  <span className="audit-where">{[e.context.client, e.context.country].filter(Boolean).join(' · ')}</span>
                  <span className={`audit-sev sev-${e.severity}`}>{t(e.severity)}</span>
                </button>
                {open === e.id && (
                  <div className="audit-detail">
                    <code>{e.action}</code>
                    {e.context.ip_address && <span>IP {e.context.ip_address}</span>}
                    <pre>{JSON.stringify({ actor: e.actor, entity: e.entity, details: e.details, context: e.context }, null, 2)}</pre>
                  </div>
                )}
              </div>
            ))}
          </div>
          {cursor && <button type="button" className="studio-btn audit-more" disabled={busy} onClick={() => void load(true)}>{busy ? t('Loading…') : t('Load more')}</button>}
        </>
      )}
    </section>
  )
}
