import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Dialog } from './Dialog'
import type { ReauthRequest } from '../utils/authGuard'

type Method = 'email_code' | 'password' | 'sign_in_again'

/// "Confirm it's you": asked for when an admin action wants a recent
/// sign-in (utils/authGuard). A code to your email, or your password; the
/// action you were taking then goes through by itself.
export const ReauthDialog: React.FC = () => {
  const t = useT()
  const [ask, setAsk] = useState<ReauthRequest | null>(null)
  const [method, setMethod] = useState<Method | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent<ReauthRequest>).detail
      e.preventDefault()
      setAsk((current) => {
        // One at a time: a second request waiting joins the first's answer.
        if (current) {
          const first = current.resolve
          current.resolve = (ok) => { first(ok); detail.resolve(ok) }
          return current
        }
        return detail
      })
    }
    window.addEventListener('honmaru:reauth', on)
    return () => window.removeEventListener('honmaru:reauth', on)
  }, [])

  useEffect(() => {
    if (!ask) return
    setMethod(null); setValue(''); setError(null)
    fetch(`${ask.base}/auth/reauth/start`, { method: 'POST', headers: { 'x-session-token': ask.token, 'content-type': 'application/json' }, body: '{}' })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) { setError(d.message || t('That did not work.')); setMethod('sign_in_again'); return }
        setMethod(d.method); setEmail(d.email || null)
      })
      .catch(() => setError(t('That did not work.')))
  }, [ask])

  if (!ask) return null
  const finish = (ok: boolean) => { ask.resolve(ok); setAsk(null) }
  const confirm = async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${ask.base}/auth/reauth`, {
        method: 'POST', headers: { 'x-session-token': ask.token, 'content-type': 'application/json' },
        body: JSON.stringify(method === 'password' ? { password: value } : { code: value.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return }
      finish(true)
    } finally { setBusy(false) }
  }

  return (
    <Dialog
      title={t("Confirm it's you")}
      lede={t('This change needs a recent sign-in.')}
      onClose={() => finish(false)}
      footer={method && method !== 'sign_in_again' ? (
        <>
          <button className="dlg-btn" onClick={() => finish(false)}>{t('Cancel')}</button>
          <button className="dlg-btn primary" data-reauth-confirm disabled={busy || !value.trim()} onClick={() => void confirm()}>{t('Confirm')}</button>
        </>
      ) : (
        <button className="dlg-btn" onClick={() => finish(false)}>{t('Close')}</button>
      )}
    >
      <form data-reauth onSubmit={(e) => { e.preventDefault(); if (value.trim()) void confirm() }}>
        {method === null && <p className="dlg-note">{t('One moment…')}</p>}
        {method === 'email_code' && (
          <>
            <p className="dlg-note">{t('We sent a six-digit code to {email}.', { email: email || t('your email') })}</p>
            <input className="dlg-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={value}
              onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} aria-label={t('Code')} data-reauth-code />
          </>
        )}
        {method === 'password' && (
          <input className="dlg-input" type="password" autoComplete="current-password" value={value}
            onChange={(e) => setValue(e.target.value)} aria-label={t('Password')} placeholder={t('Password')} data-reauth-password />
        )}
        {method === 'sign_in_again' && <p className="dlg-note">{t('Sign out and sign in again, then try once more.')}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  )
}
