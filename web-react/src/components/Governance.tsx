import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

// Compliance, in the Studio (docs/enterprise-audit-log.md §10): how long
// messages and files are kept, legal holds, exports for a legal matter, the
// networks the workspace may be used from, and who may be invited. Owners
// change them; admins see them.

interface Gov {
  retention: { publicDays: number | null; privateDays: number | null; dmDays: number | null; filesDays: number | null }
  network: { enforce: boolean; allowlist: string[] }
  invites: { policy: 'open' | 'company' | 'approval'; guestsExempt: boolean }
  canEdit: boolean
  yourIp: string | null
  retentionChoices: Array<number | null>
}
interface Hold { id: string; kind: 'person' | 'channel'; reason: string; createdAt: string; releasedAt: string | null; target: { ref?: string | null; name?: string; channel?: string } }
interface Export { id: string; status: string; from: string; to: string; filters: { people?: string[]; channels?: string[]; reason?: string }; counts: { messages: number; earlier: number; files: number; truncated: boolean } | null; createdAt: string; expiresAt: string }
interface Member { ref: string; name: string }
interface Channel { slug: string; name: string }

const day = (iso: string) => iso.slice(0, 10)

export const Governance: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const [gov, setGov] = useState<Gov | null>(null)
  const [denied, setDenied] = useState(false)
  const [holds, setHolds] = useState<Hold[]>([])
  const [exports, setExports] = useState<Export[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [cidrs, setCidrs] = useState('')
  const [hold, setHold] = useState({ kind: 'person' as 'person' | 'channel', ref: '', channel: '', reason: '' })
  const today = new Date().toISOString().slice(0, 10)
  const [exp, setExp] = useState({ from: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), to: today, people: [] as string[], reason: '' })
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const q = `orgId=${encodeURIComponent(orgId)}`
  const headers = { 'x-session-token': sessionToken, 'content-type': 'application/json' }

  const load = useCallback(async () => {
    const g = await fetch(`${httpBase}/orgs/governance?${q}`, { headers: { 'x-session-token': sessionToken } }).catch(() => null)
    if (g?.status === 403) { setDenied(true); return }
    if (!g?.ok) return
    const data = await g.json() as Gov
    setGov(data); setCidrs(data.network.allowlist.join('\n'))
    const [h, m, c] = await Promise.all([
      fetch(`${httpBase}/orgs/holds?${q}`, { headers: { 'x-session-token': sessionToken } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${httpBase}/members?${q}`, { headers: { 'x-session-token': sessionToken } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${httpBase}/businesses?${q}`, { headers: { 'x-session-token': sessionToken } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    setHolds(h?.holds || []); setMembers(m?.members || []); setChannels(c?.businesses || [])
    if (data.canEdit) {
      const e = await fetch(`${httpBase}/orgs/compliance/exports?${q}`, { headers: { 'x-session-token': sessionToken } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      setExports(e?.exports || [])
    }
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { void load() }, [load])

  const send = async (path: string, method: string, body: Record<string, unknown>, done?: string) => {
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await fetch(`${httpBase}${path}${method === 'DELETE' ? `?${q}` : ''}`, { method, headers, ...(method === 'DELETE' ? {} : { body: JSON.stringify({ orgId, ...body }) }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return null }
      if (done) setNote(done)
      await load()
      return data
    } finally { setBusy(false) }
  }
  const download = async (id: string) => {
    const res = await fetch(`${httpBase}/orgs/compliance/exports/${encodeURIComponent(id)}/download?${q}`, { headers: { 'x-session-token': sessionToken } }).catch(() => null)
    if (!res?.ok) { setError(t('That export has expired or is not ready.')); return }
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url; a.download = `export-${id.slice(0, 8)}.jsonl.gz`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  if (denied) return <section className="studio-page" data-studio-page="compliance"><h1 className="studio-title">{t('Compliance')}</h1><p className="studio-lede">{t('Only an admin can see these settings.')}</p></section>
  if (!gov) return <section className="studio-page" data-studio-page="compliance"><h1 className="studio-title">{t('Compliance')}</h1></section>
  const edit = gov.canEdit
  const label = (d: number | null) => (d === null ? t('For ever') : d < 30 ? t('{n} days', { n: d }) : d % 365 === 0 ? t('{n} years', { n: d / 365 }) : t('{n} days', { n: d }))
  const retentionRow = (key: keyof Gov['retention'], name: string) => (
    <label className="rules-input" key={key}>{name}{' '}
      <select className="rules-number" value={gov.retention[key] ?? ''} disabled={!edit || busy} data-retention={key}
        onChange={(e) => void send('/orgs/governance', 'PUT', { retention: { [key]: e.target.value === '' ? null : Number(e.target.value) } }, t('Saved.'))}>
        {gov.retentionChoices.map((d) => <option key={String(d)} value={d ?? ''}>{label(d)}</option>)}
      </select>
    </label>
  )

  return (
    <section className="studio-page sso-page" data-studio-page="compliance">
      <h1 className="studio-title">{t('Compliance')}</h1>
      <p className="studio-lede">{t('How long this workspace keeps what is said in it, what is held regardless, exports for a legal matter, where it can be used from, and who may be invited.')}</p>
      {note && <p className="rules-note" role="status">{note}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="studio-section-head"><div><h2>{t('Retention')}</h2><p>{t('Past this, messages and files are deleted every day — except what a legal hold covers.')}</p></div></div>
      <div className="sso-domain">
        {retentionRow('publicDays', t('Public channels'))}
        {retentionRow('privateDays', t('Private channels'))}
        {retentionRow('dmDays', t('Direct messages'))}
        {retentionRow('filesDays', t('Files'))}
      </div>

      <div className="studio-section-head"><div><h2>{t('Legal holds')}</h2><p>{t("A person's or a channel's messages kept regardless of retention. Their earlier words are kept through edits and deletions, for exports only.")}</p></div></div>
      {holds.map((h) => (
        <div key={h.id} className="sso-domain" data-hold={h.id}>
          <div className="sso-domain-head">
            <b>{h.kind === 'person' ? h.target.name : `#${(h.target.channel || '').slice(2)}`}</b>
            <span className={`sso-badge${h.releasedAt ? '' : ' ok'}`}>{h.releasedAt ? t('Released') : t('Held')}</span>
          </div>
          <p className="row-sub">{h.reason} · {day(h.createdAt)}</p>
          {edit && !h.releasedAt && <div className="rules-actions"><button type="button" className="studio-btn danger" disabled={busy} onClick={() => void send(`/orgs/holds/${encodeURIComponent(h.id)}`, 'DELETE', {}, t('Released.'))}>{t('Release')}</button></div>}
        </div>
      ))}
      {edit && (
        <form className="sso-domain" data-hold-add onSubmit={(e) => { e.preventDefault(); void send('/orgs/holds', 'POST', hold, t('The hold is on.')).then((ok) => { if (ok) setHold({ ...hold, reason: '' }) }) }}>
          <div className="rules-actions">
            <select className="rules-number" value={hold.kind} onChange={(e) => setHold({ ...hold, kind: e.target.value as 'person' | 'channel' })}>
              <option value="person">{t('A person')}</option>
              <option value="channel">{t('A channel')}</option>
            </select>
            {hold.kind === 'person'
              ? <select className="rules-number" value={hold.ref} onChange={(e) => setHold({ ...hold, ref: e.target.value })} data-hold-person><option value="">{t('Choose…')}</option>{members.map((m) => <option key={m.ref} value={m.ref}>{m.name}</option>)}</select>
              : <select className="rules-number" value={hold.channel} onChange={(e) => setHold({ ...hold, channel: e.target.value })}><option value="">{t('Choose…')}</option>{channels.map((c) => <option key={c.slug} value={`b:${c.slug}`}>#{c.name}</option>)}</select>}
          </div>
          <input className="rules-number wide" placeholder={t('The matter, e.g. case number')} value={hold.reason} onChange={(e) => setHold({ ...hold, reason: e.target.value })} data-hold-reason />
          <div className="rules-actions"><button type="submit" className="studio-btn primary" disabled={busy || !hold.reason.trim() || (hold.kind === 'person' ? !hold.ref : !hold.channel)}>{t('Place a hold')}</button></div>
        </form>
      )}

      {edit && (
        <>
          <div className="studio-section-head"><div><h2>{t('Export')}</h2><p>{t('Everything said in the dates you choose — private channels and direct messages included — with the earlier words of held messages. Every owner is told, and it can be downloaded for 7 days.')}</p></div></div>
          <form className="sso-domain" data-export-form onSubmit={(e) => { e.preventDefault(); void send('/orgs/compliance/exports', 'POST', { from: `${exp.from}T00:00:00Z`, to: `${exp.to}T23:59:59Z`, people: exp.people, reason: exp.reason }, t('The export is ready.')) }}>
            <div className="rules-actions">
              <label className="rules-input">{t('From')} <input type="date" className="rules-number" value={exp.from} max={exp.to} onChange={(e) => setExp({ ...exp, from: e.target.value })} /></label>
              <label className="rules-input">{t('To')} <input type="date" className="rules-number" value={exp.to} max={today} onChange={(e) => setExp({ ...exp, to: e.target.value })} /></label>
            </div>
            <div className="org-key-scopes">
              <span className="row-sub">{t('Only these people (none chosen: everyone)')}</span>
              {members.map((m) => (
                <label key={m.ref} className="dlg-check"><input type="checkbox" checked={exp.people.includes(m.ref)} onChange={() => setExp({ ...exp, people: exp.people.includes(m.ref) ? exp.people.filter((r) => r !== m.ref) : [...exp.people, m.ref] })} /> {m.name}</label>
              ))}
            </div>
            <input className="rules-number wide" placeholder={t('The matter, e.g. case number')} value={exp.reason} onChange={(e) => setExp({ ...exp, reason: e.target.value })} data-export-reason />
            <div className="rules-actions"><button type="submit" className="studio-btn primary" disabled={busy || !exp.reason.trim()}>{t('Export')}</button></div>
          </form>
          {exports.map((x) => (
            <div key={x.id} className="sso-domain" data-export={x.id}>
              <div className="sso-domain-head">
                <b>{day(x.from)} – {day(x.to)}</b>
                <span className={`sso-badge${x.status === 'ready' ? ' ok' : ''}`}>{x.status === 'ready' ? t('Ready') : x.status === 'expired' ? t('Expired') : x.status === 'failed' ? t('Failed') : t('Running')}</span>
              </div>
              <p className="row-sub">{x.filters.reason}{x.counts ? ` · ${t('{n} messages', { n: x.counts.messages })}` : ''}{x.counts?.truncated ? ` · ${t('cut short: narrow the dates')}` : ''}</p>
              {x.status === 'ready' && <div className="rules-actions"><button type="button" className="studio-btn" onClick={() => void download(x.id)}>{t('Download')}</button></div>}
            </div>
          ))}
        </>
      )}

      <div className="studio-section-head"><div><h2>{t('Allowed networks')}</h2><p>{t('When on, this workspace — web, phone and API sessions — can only be used from these addresses. Your address now: {ip}', { ip: gov.yourIp || '?' })}</p></div></div>
      <form className="sso-domain" data-network onSubmit={(e) => { e.preventDefault(); void send('/orgs/governance', 'PUT', { network: { allowlist: cidrs, enforce: gov.network.enforce } }, t('Saved.')) }}>
        <textarea className="rules-number wide" rows={3} placeholder="203.0.113.0/24&#10;2001:db8::/32" value={cidrs} disabled={!edit} onChange={(e) => setCidrs(e.target.value)} data-network-cidrs />
        {edit && (
          <div className="rules-actions">
            <button type="submit" className="studio-btn" disabled={busy}>{t('Save')}</button>
            <button type="button" className="studio-btn" disabled={busy} data-network-toggle onClick={() => void send('/orgs/governance', 'PUT', { network: { allowlist: cidrs, enforce: !gov.network.enforce } }, gov.network.enforce ? t('Allowed from anywhere again.') : t('Only these networks now.'))}>
              {gov.network.enforce ? t('Allow from anywhere') : t('Only these networks')}
            </button>
          </div>
        )}
        <p className="row-sub">{gov.network.enforce ? t('On: other addresses are refused.') : t('Off: any address may be used.')}</p>
      </form>

      <div className="studio-section-head"><div><h2>{t('Who may be invited')}</h2></div></div>
      <div className="sso-domain">
        <label className="rules-input">{t('New people by invitation')}{' '}
          <select className="rules-number wide" value={gov.invites.policy} disabled={!edit || busy} data-invite-policy
            onChange={(e) => void send('/orgs/governance', 'PUT', { invites: { policy: e.target.value } }, t('Saved.'))}>
            <option value="open">{t('Anyone with the link')}</option>
            <option value="company">{t('Only people at our verified domains')}</option>
            <option value="approval">{t('Others once an admin approves')}</option>
          </select>
        </label>
        <label className="dlg-check"><input type="checkbox" checked={gov.invites.guestsExempt} disabled={!edit || busy || gov.invites.policy === 'open'}
          onChange={(e) => void send('/orgs/governance', 'PUT', { invites: { guestsExempt: e.target.checked } }, t('Saved.'))} /> {t('Guests from outside may still be invited')}</label>
      </div>
      {!edit && <p className="form-note">{t('An owner of this workspace can change these.')}</p>}
    </section>
  )
}
