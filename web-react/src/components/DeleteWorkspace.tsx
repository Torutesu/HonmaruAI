import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

// Deleting the workspace, for an owner: typed by its name, carried out
// thirty days later, and taken back any time before (worker/src/
// workspaceDeletion.js). Meanwhile nobody but its owners can open it.

export const DeleteWorkspace: React.FC<{ httpBase: string; orgId: string; sessionToken: string; name: string }> = ({ httpBase, orgId, sessionToken, name }) => {
  const t = useT()
  const [dueAt, setDueAt] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headers = { 'x-session-token': sessionToken, 'content-type': 'application/json' }

  const load = useCallback(async () => {
    const res = await fetch(`${httpBase}/orgs/delete?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => ({})) : {}
    setDueAt(data.dueAt || null)
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { void load() }, [load])

  const call = async (path: string, body: object) => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${httpBase}${path}`, { method: 'POST', headers, body: JSON.stringify({ orgId, ...body }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return }
      setTyped('')
      await load()
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className="rows-title">{t('Delete the workspace')}</div>
      <div className="team-transfer" data-delete-workspace>
        {dueAt ? (
          <>
            <span className="row-sub">{t('It will be deleted on {date}. Until then only owners can open it.', { date: new Date(dueAt).toLocaleDateString() })}</span>
            <button className="pill-btn" disabled={busy} onClick={() => void call('/orgs/delete/cancel', {})}>{t('Keep the workspace')}</button>
          </>
        ) : (
          <>
            <span className="row-sub">{t('Everything in it is deleted 30 days after you ask. Until then you can take it back.')}</span>
            <input className="dlg-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={name} aria-label={t('Type the workspace name to confirm')} />
            <button className="pill-btn danger" disabled={busy || typed.trim() !== name} onClick={() => void call('/orgs/delete', { confirm: typed.trim() })}>{t('Delete the workspace')}</button>
          </>
        )}
        {error && <span className="row-sub err" role="alert">{error}</span>}
      </div>
    </>
  )
}
