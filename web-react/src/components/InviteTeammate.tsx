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

  const copyCode = () => {
    if (!code) return
    navigator.clipboard?.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="info-panel">
      <h3>Invite a teammate</h3>
      {!code ? (
        <>
          <div style={{ marginBottom: '0.5rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#666', display: 'block', marginBottom: '0.25rem' }}>
              Their role:
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={{ padding: '0.4rem', borderRadius: '6px', width: '100%' }}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <button className="debug-toggle" onClick={handleInvite} disabled={busy}>
            {busy ? 'Creating…' : 'Create invite code'}
          </button>
          {error && <div className="create-error">{error}</div>}
        </>
      ) : (
        <div>
          <p style={{ fontSize: '0.85rem', color: '#666' }}>
            Share this code. Anyone who signs up with it joins your team as <strong>{role}</strong>:
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <code style={{ background: '#f0f0f0', padding: '0.4rem 0.6rem', borderRadius: '6px', fontSize: '0.9rem' }}>
              {code}
            </code>
            <button className="debug-toggle" onClick={copyCode} style={{ padding: '0.4rem 0.8rem' }}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button
            className="debug-toggle"
            onClick={() => { setCode(null); setError(null) }}
            style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}
          >
            Create another
          </button>
        </div>
      )}
    </div>
  )
}