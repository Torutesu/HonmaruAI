import React, { useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'

interface Props {
  httpBase: string
  email: string
  name: string
  inviteCode: string
  onVerified: (token: string, userId: string, orgId: string, created: boolean) => void
  onBack: () => void
}

const LENGTH = 6
const RESEND_SECONDS = 60

/// Six boxes and a countdown.
///
/// The boxes are one input per digit because that is what a phone keyboard
/// and a paste both expect: typing advances, backspace retreats, and pasting
/// the whole code from a mail app fills all six at once. Anything less and
/// people retype a code they already have on the clipboard.
export const Otp: React.FC<Props> = ({ httpBase, email, name, inviteCode, onVerified, onBack }) => {
  const t = useT()
  const [digits, setDigits] = useState<string[]>(Array(LENGTH).fill(''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [wait, setWait] = useState(RESEND_SECONDS)
  // A session that is good, held back only by an invite code that was not.
  const [pending, setPending] = useState<{ token: string; uid: string; org: string; created: boolean } | null>(null)
  const inputs = useRef<Array<HTMLInputElement | null>>([])
  const code = digits.join('')

  useEffect(() => { inputs.current[0]?.focus() }, [])
  useEffect(() => {
    if (wait <= 0) return
    const id = setTimeout(() => setWait((w) => w - 1), 1000)
    return () => clearTimeout(id)
  }, [wait])

  const verify = async (value: string) => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${httpBase}/auth/otp/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code: value, name, inviteCode: inviteCode || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.message || t('That code is not valid.'))
        setDigits(Array(LENGTH).fill(''))
        inputs.current[0]?.focus()
        return
      }
      // Signed in, but the invite code they pasted did not work. The emailed
      // code was right so the session stands; saying nothing would drop them
      // into their own workspace wondering where the team went.
      if (data.inviteError) {
        setError(data.inviteError)
        setDigits(Array(LENGTH).fill(''))
        setPending({ token: data.token, uid: data.login || data.userId, org: data.orgId || '', created: Boolean(data.created) })
        return
      }
      onVerified(data.token, data.login || data.userId, data.orgId || '', Boolean(data.created))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  // Six digits present means the person is done typing. Making them press a
  // button as well is a step that exists only to be pressed.
  useEffect(() => {
    if (code.length === LENGTH && !busy) verify(code)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  const setDigit = (index: number, raw: string) => {
    const clean = raw.replace(/\D/g, '')
    if (!clean) {
      setDigits((d) => d.map((v, i) => (i === index ? '' : v)))
      return
    }
    setDigits((d) => {
      const next = [...d]
      // A paste lands in one box and fills the rest from there.
      for (let i = 0; i < clean.length && index + i < LENGTH; i++) next[index + i] = clean[i]
      return next
    })
    const landing = Math.min(index + clean.length, LENGTH - 1)
    inputs.current[landing]?.focus()
  }

  const onKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      e.preventDefault()
      setDigits((d) => d.map((v, i) => (i === index - 1 ? '' : v)))
      inputs.current[index - 1]?.focus()
    }
    if (e.key === 'ArrowLeft' && index > 0) inputs.current[index - 1]?.focus()
    if (e.key === 'ArrowRight' && index < LENGTH - 1) inputs.current[index + 1]?.focus()
  }

  const resend = async () => {
    setError(null); setNote(null)
    const res = await fetch(`${httpBase}/auth/otp/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.message || t('We could not send another code.')); return }
    setNote(t('Sent. Check your email again.'))
    setWait(RESEND_SECONDS)
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onBack} aria-label={t('Back')}>‹</button>
        <span className="head-title">{t('Check your email')}</span>
      </div>
      <div className="screen-body">
        <h1 className="display" style={{ fontSize: 28 }}>{t('Enter the code.')}</h1>
        <p className="lede">
          {t('We sent six digits to')} <b style={{ color: 'var(--ink-black)' }}>{email}</b>{t('. It is good for ten minutes, once.')}
        </p>

        <div className="otp-boxes">
          {digits.map((digit, i) => (
            <input
              key={i}
              ref={(el) => { inputs.current[i] = el }}
              className={`otp-box${digit ? ' filled' : ''}`}
              value={digit}
              onChange={(e) => setDigit(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
              inputMode="numeric"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              maxLength={LENGTH}
              aria-label={t('Digit {n}', { n: i + 1 })}
              disabled={busy}
            />
          ))}
        </div>

        {note && <div className="form-note">{note}</div>}
        {error && <div className="form-error">{error}</div>}

        {/* Quiet, and second: the primary action on this screen is still the
            six digits. This is the way out for someone whose sign-in worked
            and whose invite code did not — they are already signed in, and
            You → Join a team takes another attempt at the code. */}
        {pending && (
          <button
            className="btn btn-quiet"
            onClick={() => onVerified(pending.token, pending.uid, pending.org, pending.created)}
          >
            {t('Continue without the code')}
          </button>
        )}

        <button className="btn btn-primary" disabled={code.length !== LENGTH || busy} onClick={() => verify(code)}>
          {busy ? t('Checking…') : t('Continue')}
        </button>
        <button className="btn btn-quiet" disabled={wait > 0} onClick={resend}>
          {wait > 0 ? t('Send another code in {n}s', { n: wait }) : t('Send another code')}
        </button>
      </div>
    </div>
  )
}
