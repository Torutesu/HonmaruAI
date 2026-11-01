import React, { useEffect, useRef, useState } from 'react'
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
  const pending = useRef<ReauthRequest | null>(null)
  const [method, setMethod] = useState<Method | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent<ReauthRequest>).detail
      e.preventDefault()
      if (!detail.current()) { detail.resolve(false); return }
      const current=pending.current
      if (current && current.current()) {
        // Both fences match the currently stored session, so one confirmation
        // can safely settle both requests.
        const first=current.resolve
        current.resolve=ok=>{first(ok);detail.resolve(ok)}
        return
      }
      current?.resolve(false)
      pending.current=detail
      setAsk(detail)
    }
    const onStorage=()=>{
      if(pending.current && !pending.current.current()){
        pending.current.resolve(false);pending.current=null;setAsk(null)
      }
    }
    window.addEventListener('honmaru:reauth', on)
    window.addEventListener('storage',onStorage)
    return () => {
      window.removeEventListener('honmaru:reauth', on)
      window.removeEventListener('storage',onStorage)
      pending.current?.resolve(false);pending.current=null
    }
  }, [])

  useEffect(() => {
    if (!ask) return
    let active=true
    setMethod(null); setValue(''); setError(null)
    ask.start()
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if(!active || !ask.current())return
        if (!ok) { setError(d.message || t('That did not work.')); setMethod('sign_in_again'); return }
        setMethod(d.method); setEmail(d.email || null)
      })
      .catch(() => {if(active && ask.current())setError(t('That did not work.'))})
    return ()=>{active=false}
  }, [ask])

  if (!ask) return null
  const finish = (ok: boolean) => { pending.current=null; ask.resolve(ok && ask.current()); setAsk(null) }
  const confirm = async () => {
    if(!ask.current()){finish(false);return}
    setBusy(true); setError(null)
    try {
      const res = await ask.confirm(method === 'password' ? { password: value } : { code: value.trim() })
      const data = await res.json().catch(() => ({}))
      if(!ask.current()){finish(false);return}
      if (!res.ok) { setError(data.message || t('That did not work.')); return }
      finish(true)
    } catch { if(ask.current())setError(t('That did not work.')) }
    finally { setBusy(false) }
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
