import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

interface Plan {
  id: string
  name: string
  monthly: number
  annualMonthly: number
  perSeat?: boolean
  tagline: string
  features: string[]
}
interface Status {
  plan: string
  pro: boolean
  purchasable: boolean
  trialDays: number
  freeDailyRoutes: number
  dailyLimit: number
  usedToday: number
  remainingToday: number | null
  currency: string
  plans: Plan[]
}

interface Props {
  httpBase: string
  sessionToken: string
  onClose: () => void
}

/// Choose your plan.
///
/// The prices come from the Worker, not from here: two clients read this
/// screen and a price that disagrees between them is worse than no price. When
/// billing has no credentials the Worker says `purchasable: false` and the
/// screen says so too — an inert button would be the dishonest version.
export const Plans: React.FC<Props> = ({ httpBase, sessionToken, onClose }) => {
  const t = useT()
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [annual, setAnnual] = useState(true)
  const [chosen, setChosen] = useState('pro')

  useEffect(() => {
    fetch(`${httpBase}/billing/status`, { headers: { 'x-session-token': sessionToken } })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Could not load plans.')
        setStatus(await res.json())
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [httpBase, sessionToken])

  const paid = (status?.plans || []).filter((p) => p.monthly > 0)
  const selected = paid.find((p) => p.id === chosen)
  const price = (p: Plan) => (annual ? p.annualMonthly : p.monthly)

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Choose your plan')}</span>
      </div>
      <div className="screen-body">
        {error && <div className="form-error">{error}</div>}
        {!status && !error && <div className="empty">{t('Loading…')}</div>}

        {status && (
          <>
            {status.pro ? (
              <div className="form-note">{t('You are on Pro. Unlimited routing, every business, the full record.')}</div>
            ) : (
              <p className="lede" style={{ marginTop: 4 }}>
                Free gives you {status.dailyLimit} AI-routed decisions a day
                {status.remainingToday !== null && <> — <b style={{ color: 'var(--ink-black)' }}>{status.remainingToday} left today</b></>}.
                Paid removes the limit and turns on everything the AI does in the background.
              </p>
            )}

            <div className="billing-toggle" role="tablist" aria-label={t('Billing period')}>
              <button role="tab" aria-selected={annual} className={annual ? 'on' : ''} onClick={() => setAnnual(true)}>
                {t('Annual')} <span className="save">{t('save 20%')}</span>
              </button>
              <button role="tab" aria-selected={!annual} className={!annual ? 'on' : ''} onClick={() => setAnnual(false)}>
                Monthly
              </button>
            </div>

            {paid.map((p) => (
              <button
                key={p.id}
                className={`plan-card${chosen === p.id ? ' on' : ''}`}
                onClick={() => setChosen(p.id)}
                aria-pressed={chosen === p.id}
              >
                <div className="plan-head">
                  <div>
                    <b>{p.name}</b>
                    <span className="plan-tagline">{p.tagline}</span>
                  </div>
                  <div className="plan-price">
                    <b>${price(p)}</b>
                    <span>/{p.perSeat ? 'user/' : ''}mo</span>
                  </div>
                </div>
                <ul className="plan-features">
                  {p.features.map((f) => <li key={f}>{f}</li>)}
                </ul>
                {annual && <span className="pill-tag blue">Billed yearly · ${price(p) * 12}</span>}
              </button>
            ))}

            <div className="rows-title">{t('Free')}</div>
            <div className="rows">
              {(status.plans.find((p) => p.id === 'free')?.features || []).map((f) => (
                <div key={f} className="row static"><span className="row-main">{f}</span></div>
              ))}
            </div>
          </>
        )}
        <div style={{ height: 12 }} />
      </div>

      {status && !status.pro && (
        <div className="screen-foot">
          <button
            className="btn btn-primary"
            disabled={!status.purchasable}
            onClick={() => setError('Subscriptions are bought in the iOS app, through the App Store.')}
          >
            {status.purchasable
              ? `Start ${status.trialDays}-day free trial`
              : 'Billing is not switched on yet'}
          </button>
          <p className="foot-note">
            {status.purchasable
              ? `Free for ${status.trialDays} days, then $${selected ? price(selected) : ''}${selected?.perSeat ? ' per person' : ''} a month. Cancel any time.`
              : `Nothing is for sale on this deployment yet. Everyone gets ${status.dailyLimit} AI-routed decisions a day in the meantime.`}
          </p>
        </div>
      )}
    </div>
  )
}
