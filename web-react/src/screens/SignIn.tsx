import React, { useState } from 'react'

interface Props {
  httpBase: string
  mode: 'signup' | 'login'
  /// A code was sent; go and collect it.
  onCodeSent: (email: string, name: string, inviteCode: string) => void
  /// Signed in outright with a password.
  onSignedIn: (token: string, userId: string, orgId: string) => void
  onBack: () => void
  onSwitchMode: (mode: 'signup' | 'login') => void
}

/// Email first, code by default, password as the fallback.
///
/// A code is the credential that works on a device you have just picked up,
/// and it proves the address every notification this product sends depends on.
/// A password still works — some deployments have no mail configured at all —
/// so this screen carries both, with the code path in front.
export const SignIn: React.FC<Props> = ({ httpBase, mode, onCodeSent, onSignedIn, onBack, onSwitchMode }) => {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [password, setPassword] = useState('')
  const [usePassword, setUsePassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${httpBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { res, data: await res.json().catch(() => ({})) }
  }

  const sendCode = async () => {
    setBusy(true); setError(null); setNote(null)
    try {
      const { res, data } = await post('/auth/otp/request', { email: email.trim() })
      if (res.status === 503) {
        // This deployment has no mail. Say so once and show the password form,
        // rather than leaving someone waiting for an email nobody can send.
        setUsePassword(true)
        setNote('This workspace cannot send email yet — use a password for now.')
        return
      }
      if (!res.ok) { setError(data.message || 'We could not send a code.'); return }
      onCodeSent(email.trim(), name.trim(), inviteCode.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const withPassword = async () => {
    setBusy(true); setError(null)
    try {
      const path = mode === 'signup' ? '/auth/signup' : '/auth/login'
      const body: Record<string, unknown> = { email: email.trim(), password }
      if (mode === 'signup') {
        body.name = name.trim()
        if (inviteCode.trim()) body.inviteCode = inviteCode.trim()
      }
      const { res, data } = await post(path, body)
      if (!res.ok) { setError(data.message || 'Something went wrong.'); return }
      onSignedIn(data.token, data.login || data.userId, data.orgId || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const emailLooksReal = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  const canSubmit = emailLooksReal && (!usePassword || password.length >= 8) && !busy

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
        <span className="head-title">{mode === 'signup' ? 'Create account' : 'Sign in'}</span>
      </div>
      <div className="screen-body">
        <h1 className="display" style={{ fontSize: 28 }}>
          {mode === 'signup' ? 'Your AI needs an address.' : 'Welcome back.'}
        </h1>
        <p className="lede">
          {usePassword
            ? 'Email and password.'
            : 'We send a six-digit code. Nothing to remember, and it proves where your decisions should reach you.'}
        </p>

        <form onSubmit={(e) => { e.preventDefault(); if (canSubmit) (usePassword ? withPassword() : sendCode()) }}>
          {mode === 'signup' && (
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input id="name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="What your team calls you" autoComplete="name" />
            </div>
          )}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com" autoComplete="email" autoFocus inputMode="email" />
          </div>

          {usePassword && (
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
            </div>
          )}

          {mode === 'signup' && (
            <div className="field">
              <label htmlFor="invite">Invite code <span style={{ color: 'var(--ash)' }}>(optional)</span></label>
              <input id="invite" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Paste one to join a team" />
              <div className="hint">No code? You get a workspace of your own, and can invite people into it.</div>
            </div>
          )}

          {note && <div className="form-note">{note}</div>}
          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {busy ? 'One moment…' : usePassword ? (mode === 'signup' ? 'Create account' : 'Sign in') : 'Email me a code'}
          </button>
        </form>

        <button className="btn btn-quiet" onClick={() => { setError(null); setUsePassword(!usePassword) }}>
          {usePassword ? 'Email me a code instead' : 'Use a password instead'}
        </button>
        <button className="btn btn-quiet" onClick={() => { setError(null); onSwitchMode(mode === 'signup' ? 'login' : 'signup') }}>
          {mode === 'signup' ? 'I already have an account' : 'Create an account'}
        </button>
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}
