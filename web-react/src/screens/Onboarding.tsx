import React, { useState } from 'react'
import { LOCALE_NAMES } from '../utils/locale'
import { useT } from '../utils/i18n'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  onDone: () => void
}

// English keys; translated at the render site so a language change repaints them.
const ROLES: Array<{ id: string; label: string; blurb: string }> = [
  { id: 'founder', label: 'Founder / operator', blurb: 'You decide most things, and want the rest to stop reaching you.' },
  { id: 'operator', label: 'Ops / business', blurb: 'Suppliers, bookings, money, people.' },
  { id: 'engineer', label: 'Engineer', blurb: 'Anything shipping-related routes to you.' },
  { id: 'designer', label: 'Designer', blurb: 'Anything about how it looks or reads.' },
  { id: 'member', label: 'Something else', blurb: 'Your AI works it out from what people send you.' },
]

/// Three things worth knowing, then the two answers that change how your AI
/// behaves from the first card: what you do, and what language you read.
///
/// Everything else the product could ask for — your businesses, your team,
/// your tools — it learns by being used, which is the whole design. Asking on
/// day one produces a taxonomy nobody will keep.
export const Onboarding: React.FC<Props> = ({ httpBase, orgId, sessionToken, onDone }) => {
  const t = useT()
  const [page, setPage] = useState(0)
  const [role, setRole] = useState('founder')
  const [locale, setLocale] = useState(() => (navigator.language || 'en').split('-')[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [demo, setDemo] = useState<null | 'approved' | 'declined'>(null)

  const finish = async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${httpBase}/me`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ locale, role, orgId }),
      })
      // A role you may not set (an admin picking one, say) is not a reason to
      // trap someone on the last onboarding screen. The language still saved.
      if (!res.ok && res.status !== 400) {
        setError((await res.json().catch(() => ({}))).message || t('We could not save that.'))
        return
      }
      onDone()
    } catch {
      // Offline on first run: the answers are worth less than getting in.
      onDone()
    } finally { setBusy(false) }
  }

  const pages = [
    {
      key: 'tell',
      art: <div className="ob-art ob-art-tell"><span className="ob-you">{t('You')}</span><span className="ob-arrow">→</span><span className="ob-ai">AI</span></div>,
      title: t('ob.tell.title'),
      body: t('ob.tell.body'),
    },
    {
      key: 'route',
      art: <div className="ob-art ob-art-route"><i /><i /><i /><span className="ob-hop">{t('routes to whoever decides')}</span></div>,
      title: t('ob.route.title'),
      body: t('ob.route.body'),
    },
    {
      key: 'swipe',
      art: (
        <div className="ob-art ob-demo">
          <div className={`ob-card${demo ? ` gone ${demo}` : ''}`}>
            <span className="meta-label">{t('Decision · high')}</span>
            <b>{t('Supplier price +8%')}</b>
            <p>{t('Kenji needs an answer today to hold this month’s slot.')}</p>
          </div>
          {demo && <div className="ob-demo-done">{demo === 'approved' ? t('Approved. Kenji’s AI already knows.') : t('Declined. Kenji’s AI already knows.')}</div>}
        </div>
      ),
      title: t('ob.swipe.title'),
      body: t('ob.swipe.body'),
      extra: (
        <div className="ob-demo-actions">
          <button className="ob-round no" onClick={() => setDemo('declined')} disabled={!!demo} aria-label={t('Decline')}>✕</button>
          <button className="ob-round yes" onClick={() => setDemo('approved')} disabled={!!demo} aria-label={t('Approve')}>✓</button>
        </div>
      ),
    },
  ]

  if (page < pages.length) {
    const p = pages[page]
    return (
      <div className="screen">
        <div className="screen-head">
          {page > 0 && <button className="back" onClick={() => setPage(page - 1)} aria-label={t('Back')}>‹</button>}
          <span className="spacer" />
          <button className="skip" onClick={() => setPage(pages.length)}>{t('Skip')}</button>
        </div>
        <div className="screen-body ob-body">
          {p.art}
          <h1 className="display" style={{ fontSize: 30 }}>{p.title}</h1>
          <p className="lede">{p.body}</p>
          {p.extra}
        </div>
        <div className="screen-foot bare">
          <div className="dots">{pages.map((q, i) => <i key={q.key} className={i === page ? 'on' : ''} />)}</div>
          <button className="btn btn-primary" onClick={() => setPage(page + 1)}>
            {page === pages.length - 1 ? t('Set me up') : t('Next')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={() => setPage(pages.length - 1)} aria-label={t('Back')}>‹</button>
        <span className="head-title">{t('Two questions')}</span>
      </div>
      <div className="screen-body">
        <h1 className="display" style={{ fontSize: 28 }}>{t('What do you mostly decide?')}</h1>
        <p className="lede">Your AI routes by role. This is the only thing it cannot guess on day one.</p>

        <div className="rows">
          {ROLES.map((r) => (
            <button key={r.id} className="row" onClick={() => setRole(r.id)} aria-pressed={role === r.id}>
              <span className="row-main">
                {t(r.label)}
                <span className="row-sub">{t(r.blurb)}</span>
              </span>
              <span className={`radio${role === r.id ? ' on' : ''}`} aria-hidden="true" />
            </button>
          ))}
        </div>

        <div className="rows-title">{t('Language')}</div>
        <div className="field">
          <select value={locale} onChange={(e) => setLocale(e.target.value)} aria-label={t('Language')}>
            {Object.entries(LOCALE_NAMES).map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
          <div className="hint">{t('Every notification reaches you in this language, whoever wrote it.')}</div>
        </div>

        {error && <div className="form-error">{error}</div>}
        <div style={{ height: 8 }} />
      </div>
      <div className="screen-foot bare">
        <button className="btn btn-primary" onClick={finish} disabled={busy}>
          {busy ? t('Saving…') : t('Open my feed')}
        </button>
      </div>
    </div>
  )
}
