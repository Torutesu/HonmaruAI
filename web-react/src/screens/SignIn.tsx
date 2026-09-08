import React, { useState, useEffect, useRef } from 'react'
import { useT } from '../utils/i18n'

interface Props {
  httpBase: string
  mode: 'signup' | 'login'
  /// A code was sent; go and collect it.
  onCodeSent: (email: string, name: string, inviteCode: string) => void
  /// Signed in outright with a password.
  onSignedIn: (token: string, userId: string, orgId: string) => void
  onDemo?: () => void
  onBack: () => void
  onSwitchMode: (mode: 'signup' | 'login') => void
}

/// Email first, code by default, password as the fallback.
///
/// A code is the credential that works on a device you have just picked up,
/// and it proves the address every notification this product sends depends on.
/// A password still works — some deployments have no mail configured at all —
/// so this screen carries both, with the code path in front.
export const SignIn: React.FC<Props> = ({ httpBase, mode, onCodeSent, onSignedIn, onBack, onSwitchMode, onDemo }) => {
  const t = useT()
  const live = useRef(true), request = useRef<AbortController | null>(null)
  useEffect(() => { live.current = true; return () => { live.current = false; request.current?.abort() } }, [])
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [password, setPassword] = useState('')
  const [usePassword, setUsePassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const post = async (path: string, body: unknown) => {
    request.current?.abort(); request.current = new AbortController()
    const res = await fetch(`${httpBase}${path}`, {
      method: 'POST', signal:request.current.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { res, data: await res.json().catch(() => ({})) }
  }

  const sendCode = async () => {
    setBusy(true); setError(null); setNote(null)
    try {
      const { res, data } = await post('/auth/otp/request', { email: email.trim() })
      if (!live.current) return
      if (res.status === 503) {
        // This deployment has no mail. Say so once and show the password form,
        // rather than leaving someone waiting for an email nobody can send.
        setUsePassword(true)
        setNote(t('This workspace cannot send email yet — use a password for now.'))
        return
      }
      if (!res.ok) { setError(data.message || t('We could not send a code.')); return }
      onCodeSent(email.trim(), name.trim(), inviteCode.trim())
    } catch (err) {
      if (live.current) setError(err instanceof Error ? err.message : String(err))
    } finally { if (live.current) setBusy(false) }
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
      if (!live.current) return
      if (!res.ok) { setError(data.message || t('Something went wrong.')); return }
      onSignedIn(data.token, data.login || data.userId, data.orgId || '')
    } catch (err) {
      if (live.current) setError(err instanceof Error ? err.message : String(err))
    } finally { if (live.current) setBusy(false) }
  }

  const emailLooksReal = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  const canSubmit = emailLooksReal && (!usePassword || password.length >= 8) && !busy

  return (
    <div className="screen auth-screen">
      <div className="screen-head">
        <button className="back" onClick={onBack} aria-label={t('Back')}>‹</button>
        <span className="head-title">{t(mode === 'signup' ? 'Create account' : 'Sign in')}</span>
      </div>
      <div className="screen-body">
        <h1 className="display" style={{ fontSize: 28 }}>
          {t(mode === 'signup' ? 'Your AI needs an address.' : 'Welcome back.')}
        </h1>
        <p className="lede">
          {t(usePassword ? 'Email and password.' : 'We send a six-digit code. Nothing to remember, and it proves where your decisions should reach you.')}
        </p>

        <form onSubmit={(e) => { e.preventDefault(); if (canSubmit) (usePassword ? withPassword() : sendCode()) }}>
          {mode === 'signup' && (
            <div className="field">
              <label htmlFor="name">{t('Your name')}</label>
              <input id="name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder={t('What your team calls you')} autoComplete="name" />
            </div>
          )}

          <div className="field">
            <label htmlFor="email">{t('Email')}</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder={t('you@company.com')} autoComplete="email" autoFocus inputMode="email" />
          </div>

          {usePassword && (
            <div className="field">
              <label htmlFor="password">{t('Password')}</label>
              <input id="password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('At least 8 characters')}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
            </div>
          )}

          {mode === 'signup' && (
            <div className="field">
              <label htmlFor="invite">{t('Invite code')} <span style={{ color: 'var(--ash)' }}>{t('(optional)')}</span></label>
              <input id="invite" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)}
                placeholder={t('Paste one to join a team')} />
              <div className="hint">{t('No code? You get a workspace of your own, and can invite people into it.')}</div>
            </div>
          )}

          {note && <div className="form-note">{note}</div>}
          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {t(busy ? 'One moment…' : usePassword ? (mode === 'signup' ? 'Create account' : 'Sign in') : 'Email me a code')}
          </button>
        </form>

        <button className="btn btn-quiet" disabled={busy} onClick={() => { setError(null); setUsePassword(!usePassword) }}>
          {t(usePassword ? 'Email me a code instead' : 'Use a password instead')}
        </button>
        <button className="btn btn-quiet" onClick={() => { setError(null); onSwitchMode(mode === 'signup' ? 'login' : 'signup') }}>
          {t(mode === 'signup' ? 'I already have an account' : 'Create an account')}
        </button>
        <button className="btn btn-quiet" onClick={onDemo}>{t('Try a local sample workspace')}</button><div style={{ height: 24 }} />
      </div>
    </div>
  )
}
