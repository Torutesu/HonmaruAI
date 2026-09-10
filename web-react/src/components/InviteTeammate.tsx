import React, { useState } from 'react'
import { useT } from '../utils/i18n'

interface Props {
  relayHttpUrl: string
  orgId: string
  sessionToken: string
  /// A code was minted. The team screen around this one lists the codes that
  /// are still out, and a new one belongs in that list straight away.
  onMinted?: () => void
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
export const InviteTeammate: React.FC<Props> = ({ relayHttpUrl, orgId, sessionToken, onMinted }) => {
  const t = useT()
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
      onMinted?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const copyCode = () => {
    if (!code) return
    navigator.clipboard?.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (code) {
    return (
      <div className="invite">
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
    <div className="invite">
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
