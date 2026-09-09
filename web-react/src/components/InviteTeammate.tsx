import React, { useState } from 'react'
import { useT } from '../utils/i18n'

interface Props {
  relayHttpUrl: string
  orgId: string
  sessionToken: string
  sample?: boolean
  members?: { id: string; name: string }[]
  onJoined?: (org: string) => void
  onBack?: () => void
}

/// The roles an invite can grant. The label is what the person minting the
/// code reads; the value is what the membership row gets.
const ROLES: Array<{ id: string; label: string }> = [
  { id: 'member', label: 'Member' },
  { id: 'designer', label: 'Designer' },
  { id: 'engineer', label: 'Engineer' },
  { id: 'admin', label: 'Admin' },
  { id: 'triager', label: 'Triager' },
]

/// One code, one role, one thing to hand over.
///
/// The sheet around this already carries the title, so this does not repeat
/// it, and it borrows the same rows, buttons and type as every other screen
/// rather than the hand-written styles it had — an invite is the first thing
/// a new person sees of this product through somebody else.
export const InviteTeammate: React.FC<Props> = ({ relayHttpUrl, orgId, sessionToken, members = [], sample, onJoined, onBack }) => {
  const t = useT()
  const [joinCode, setJoinCode] = useState('')
  const join = async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${relayHttpUrl}/invites/accept`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': sessionToken }, body: JSON.stringify({ code: joinCode.trim() }) })
      const data = await res.json()
      if (!res.ok || !data.orgId) throw new Error(data.message || t('Could not join workspace.'))
      onJoined?.(data.orgId); setJoinCode(''); setCode(null)
    } catch (e) { setError(e instanceof Error ? e.message : t('Could not join workspace.')) } finally { setBusy(false) }
  }
  const [code, setCode] = useState<string | null>(null)
  const [role, setRole] = useState('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const handleInvite = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${relayHttpUrl}/invites/create`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-token': sessionToken,
        },
        body: JSON.stringify({ orgId, role }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.message || t('Could not create invite.'))
        return
      }
      setCode(data.code)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const copyCode = async () => {
    if (!code) return
    try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { setError(t('The code could not be copied. Select and copy it manually.')) }
  }

  const team = <section className="team-settings"><h3>{t('Your team')}</h3><p className="form-note">{orgId}</p><ul>{members.map((m) => <li key={m.id}>{m.name}</li>)}</ul>{onJoined && <><h3>{t('Join a team')}</h3><p className="form-note">{t('Enter a code from your teammate to switch to their team.')}</p><div className="field"><label htmlFor="team-code">{t('Invite code')}</label><input id="team-code" value={joinCode} disabled={busy} onChange={(e) => setJoinCode(e.target.value)} /></div><button className="btn btn-primary" disabled={busy || !joinCode.trim()} onClick={join}>{t('Join team')}</button></>}{onBack && <button className="btn btn-quiet" onClick={onBack}>{t('Back to draft')}</button>}</section>
  if (sample) return <div className="invite"><h3>{t("Your team")}</h3><ul>{members.map((m) => <li key={m.id}>{m.name}</li>)}</ul><p>{t("Changes stay in this browser. No messages or notifications are sent.")}</p></div>
  if (code) {
    return (
      <div className="invite">{team}
        {error && <p className="form-error" role="alert">{error}</p>}
        <p className="sheet-hint">
          {t('Anyone who signs up with this code joins your workspace as {role}.', {
            role: t(ROLES.find((r) => r.id === role)?.label || role),
          })}
        </p>
        <div className="invite-row">
          <code className="invite-code">{code}</code>
          <button className="btn btn-quiet invite-copy" onClick={copyCode}>
            {copied ? t('Copied!') : t('Copy')}
          </button>
        </div>
        <button
          className="btn btn-quiet"
          onClick={() => { setCode(null); setError(null) }}
        >
          {t('Create another')}
        </button>
      </div>
    )
  }

  return (
    <div className="invite">{team}
      <div className="row static">
        <span className="row-main">
          {t('Their role')}
          <span className="row-sub">{t('What their AI puts in front of them first.')}</span>
        </span>
        <select
          className="row-select"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          aria-label={t('Their role')}
        >
          {ROLES.map((r) => <option key={r.id} value={r.id}>{t(r.label)}</option>)}
        </select>
      </div>
      <button className="btn btn-primary" onClick={handleInvite} disabled={busy}>
        {busy ? t('Creating…') : t('Create invite code')}
      </button>
      {error && <div className="form-error">{error}</div>}
    </div>
  )
}
