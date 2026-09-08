import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { LOCALE_NAMES } from '../utils/locale'
import { changeLocale, useT } from '../utils/i18n'
import './OnboardingFigma.css'

interface Props { httpBase: string; orgId: string; sessionToken: string; onDone: () => void }
const ROLES = [
  { id: 'founder', label: 'Founder / operator' }, { id: 'operator', label: 'Ops / business' },
  { id: 'engineer', label: 'Engineer' }, { id: 'designer', label: 'Designer' }, { id: 'member', label: 'Something else' },
]

/** Figma's centered question and pill choices, using the profile fields the service actually saves. */
export const Onboarding: React.FC<Props> = ({ httpBase, orgId, sessionToken, onDone }) => {
  const t = useT()
  const [page, setPage] = useState(0)
  const [role, setRole] = useState('')
  const [locale, setLocale] = useState(() => (navigator.language || 'en').split('-')[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const finish = async () => {
    if (request.current) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${httpBase}/me`, {
        method: 'PUT', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ locale, ...(role ? { role, orgId } : {}) }),
      })
      if (!res.ok) { setError(t('We could not save that.')); return }
      if (controller.signal.aborted) return
      changeLocale(locale); onDone()
    } catch {
      if (!controller.signal.aborted) setError(t('We could not save that.'))
    } finally {
      if (!controller.signal.aborted) { request.current = null; setBusy(false) }
    }
  }
  return <div className="screen onboarding-figma">
    <div className="screen-head">
      {page > 0 && <button className="back" onClick={() => { setPage(0); setError(null) }} disabled={busy} aria-label={t('Back')}><ArrowLeft size={20}/></button>}
      <span className="spacer"/><button className="skip" onClick={onDone} disabled={busy}>{t('Set up later')}</button>
    </div>
    <div className="screen-body onboarding-figma-body">
      <h1>{page === 0 ? t('What do you mostly decide?') : t('Which language do you prefer?')}</h1>
      <p>{page === 0 ? t('Choose your role. You can change it in Profile.') : t('Use Honmaru AI in the language you read.')}</p>
      <div className="onboarding-choices" role="group" aria-label={page === 0 ? t('Role') : t('Language')}>
        {page === 0 ? ROLES.map(r => <button key={r.id} className={role === r.id ? 'selected' : ''} aria-pressed={role === r.id} onClick={() => setRole(r.id)}>{t(r.label)}</button>)
          : Object.entries(LOCALE_NAMES).map(([code, label]) => <button key={code} className={locale === code ? 'selected' : ''} aria-pressed={locale === code} onClick={() => setLocale(code)}>{label}</button>)}
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
    <div className="screen-foot bare onboarding-figma-foot">
      <button className="btn btn-primary" disabled={busy || (page === 0 && !role)} onClick={page === 0 ? () => setPage(1) : finish}>{busy ? t('Saving…') : t('Continue')}</button>
      <span>{page + 1} / 2</span>
    </div>
  </div>
}
