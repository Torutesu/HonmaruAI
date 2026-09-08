import React, { useState } from 'react'

interface Props {
  relayHttpUrl: string
  orgId: string
  sessionToken: string
}

const ROLES = ['member', 'designer', 'engineer', 'admin', 'triager']

export const InviteTeammate: React.FC<Props> = ({ relayHttpUrl, orgId, sessionToken }) => {
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
        setError(data.message || 'Could not create invite.')
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
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { setError('Copy is unavailable. Select the invite code and copy it manually.') }
  }

  return (
    <div className="info-panel">
      <h3>Invite a teammate</h3>
      {!code ? (
        <>
          <div>
            <label htmlFor="invite-role">
              Their role:
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <button className="debug-toggle" onClick={handleInvite} disabled={busy}>
            {busy ? 'Creating…' : 'Create invite code'}
          </button>
        </>
      ) : (
        <div>
          <p>
            Share this code. Anyone who signs up with it joins your team as <strong>{role}</strong>:
          </p>
          <div className="invite-code">
            <code>
              {code}
            </code>
            <button className="debug-toggle" onClick={copyCode}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button
            className="debug-toggle"
            onClick={() => { setCode(null); setError(null) }}
          >
            Create another
          </button>
        </div>
      )}
      {error && <div className="create-error" role="alert">{error}</div>}
    </div>
  )
}