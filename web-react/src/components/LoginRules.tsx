import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

// The workspace's login rules, in the Studio (docs/admin-controls.md §3):
// how long a sign-in lasts here in a browser and in the app, how long it may
// sit unused, and how recent a sign-in an admin action needs. Owners change
// them; admins read them.

interface Policy { webMaxHours: number | null; mobileMaxHours: number | null; idleHours: number | null; reauthForAdminMinutes: number | null }
const EMPTY: Policy = { webMaxHours: null, mobileMaxHours: null, idleHours: null, reauthForAdminMinutes: null }
const FIELDS: Array<{ key: keyof Policy; label: string; unit: string; min: number; max: number }> = [
  { key: 'webMaxHours', label: 'Longest a browser stays signed in', unit: 'hours', min: 1, max: 2160 },
  { key: 'mobileMaxHours', label: 'Longest the iPhone app stays signed in', unit: 'hours', min: 1, max: 8760 },
  { key: 'idleHours', label: 'Signed out after going unused for', unit: 'hours', min: 1, max: 720 },
  { key: 'reauthForAdminMinutes', label: 'Admin changes need a sign-in from the last', unit: 'minutes', min: 5, max: 1440 },
]
/// Common combinations, one click each.
const PRESETS: Array<{ label: string; policy: Policy }> = [
  { label: 'No rules', policy: EMPTY },
  { label: 'Standard: browser 7 days, app 90 days', policy: { webMaxHours: 168, mobileMaxHours: 2160, idleHours: null, reauthForAdminMinutes: null } },
  { label: 'Strict: browser 12 hours, app 30 days, idle 8 hours', policy: { webMaxHours: 12, mobileMaxHours: 720, idleHours: 8, reauthForAdminMinutes: 15 } },
]

export const LoginRules: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [draft, setDraft] = useState<Record<keyof Policy, string>>({ webMaxHours: '', mobileMaxHours: '', idleHours: '', reauthForAdminMinutes: '' })
  const [canEdit, setCanEdit] = useState(false)
  const [denied, setDenied] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headers = { 'x-session-token': sessionToken, 'content-type': 'application/json' }

  const show = (p: Policy) => {
    setPolicy(p)
    setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, p[f.key] == null ? '' : String(p[f.key])])) as Record<keyof Policy, string>)
  }
  const load = useCallback(async () => {
    const res = await fetch(`${httpBase}/orgs/session-policy?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setDenied(data.message || t('That did not work.')); return }
    setCanEdit(data.canEdit === true)
    show(data.policy || EMPTY)
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { void load() }, [load])

  const save = async (next?: Policy) => {
    setBusy(true); setError(null); setNote(null)
    const body = next || Object.fromEntries(FIELDS.map((f) => [f.key, draft[f.key].trim() ? Number(draft[f.key]) : null]))
    try {
      const res = await fetch(`${httpBase}/orgs/session-policy`, { method: 'PUT', headers, body: JSON.stringify({ orgId, ...body }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not save.')); return }
      show(data.policy)
      setNote(t('Saved. It applies the next time each person opens this workspace.'))
    } finally { setBusy(false) }
  }
  const applyNow = async () => {
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await fetch(`${httpBase}/orgs/session-policy/apply`, { method: 'POST', headers, body: JSON.stringify({ orgId }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return }
      setNote(t('{n} sessions were signed out.', { n: data.ended || 0 }))
    } finally { setBusy(false) }
  }

  return (
    <section className="studio-page login-rules" data-studio-page="security">
      <h1 className="studio-title">{t('Login rules')}</h1>
      <p className="studio-lede">{t('How long a sign-in lasts in this workspace. Other workspaces keep their own rules.')}</p>
      {denied && <p className="studio-empty">{denied}</p>}
      {policy && (
        <>
          {canEdit && (
            <div className="rules-presets" role="group" aria-label={t('Presets')}>
              {PRESETS.map((p) => (
                <button key={p.label} type="button" className="studio-btn" disabled={busy} onClick={() => void save(p.policy)}>{t(p.label)}</button>
              ))}
            </div>
          )}
          <form className="rules-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
            {FIELDS.map((f) => (
              <label key={f.key} className="rules-row">
                <span className="rules-label">{t(f.label)}</span>
                <span className="rules-input">
                  <input className="rules-number" type="number" min={f.min} max={f.max} inputMode="numeric" disabled={!canEdit}
                    placeholder={t('No limit')} value={draft[f.key]} data-rule={f.key}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                  <span className="rules-unit">{t(f.unit)}</span>
                </span>
              </label>
            ))}
            {canEdit ? (
              <div className="rules-actions">
                <button type="submit" className="studio-btn primary" disabled={busy} data-rules-save>{t('Save')}</button>
                <button type="button" className="studio-btn" disabled={busy} onClick={() => void applyNow()}>{t('Sign out everyone these rules no longer allow')}</button>
              </div>
            ) : <p className="form-note">{t('An owner of this workspace can change these.')}</p>}
          </form>
          {note && <p className="rules-note" role="status">{note}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </>
      )}
    </section>
  )
}
