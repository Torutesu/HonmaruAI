import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

interface Plan {
  id: string
  name: string
  monthly: number
  annualMonthly: number
  perSeat?: boolean
  available?: boolean
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
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || t('Could not load plans.'))
        setStatus(await res.json())
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [httpBase, sessionToken])

  // Two lists, because they are two different things. `buyable` is what a tap
  // can actually start; `preview` is a tier the Worker prices but nothing
  // sells yet. They were one list, so Business — which no store product backs —
  // was selectable, and choosing it put its price under a trial button that
  // would have charged for Pro or for nothing at all.
  const paid = (status?.plans || []).filter((p) => p.monthly > 0)
  const buyable = paid.filter((p) => p.available !== false)
  const preview = paid.filter((p) => p.available === false)
  const selected = buyable.find((p) => p.id === chosen) || buyable[0]
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
                {t('Free gives you {n} AI-routed decisions a day', { n: status.dailyLimit })}
                {status.remainingToday !== null && <> — <b style={{ color: 'var(--ink-black)' }}>{t('{n} left today', { n: status.remainingToday })}</b></>}.
                {' '}{t('Paid removes the limit and turns on everything the AI does in the background.')}
              </p>
            )}

            <div className="billing-toggle" role="tablist" aria-label={t('Billing period')}>
              <button role="tab" aria-selected={annual} className={annual ? 'on' : ''} onClick={() => setAnnual(true)}>
                {t('Annual')} <span className="save">{t('save 20%')}</span>
              </button>
              <button role="tab" aria-selected={!annual} className={!annual ? 'on' : ''} onClick={() => setAnnual(false)}>
                {t('Monthly')}
              </button>
            </div>

            {buyable.map((p) => (
              <button
                key={p.id}
                className={`plan-card${selected?.id === p.id ? ' on' : ''}`}
                onClick={() => setChosen(p.id)}
                aria-pressed={selected?.id === p.id}
              >
                <div className="plan-head">
                  <div>
                    <b>{p.name}</b>
                    <span className="plan-tagline">{p.tagline}</span>
                  </div>
                  <div className="plan-price">
                    <b>${price(p)}</b>
                    <span>{p.perSeat ? t('/user/mo') : t('/mo')}</span>
                  </div>
                </div>
                <ul className="plan-features">
                  {p.features.map((f) => <li key={f}>{f}</li>)}
                </ul>
                {annual && <span className="pill-tag blue">{t('Billed yearly · ${n}', { n: price(p) * 12 })}</span>}
              </button>
            ))}

            {preview.map((p) => (
              <div key={p.id} className="plan-card" aria-disabled="true">
                <div className="plan-head">
                  <div>
                    <b>{p.name}</b>
                    <span className="plan-tagline">{p.tagline}</span>
                  </div>
                  <div className="plan-price">
                    <b>${price(p)}</b>
                    <span>{p.perSeat ? t('/user/mo') : t('/mo')}</span>
                  </div>
                </div>
                <ul className="plan-features">
                  {p.features.map((f) => <li key={f}>{f}</li>)}
                </ul>
                <span className="pill-tag">{t('Not for sale yet')}</span>
              </div>
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
            onClick={() => setError(t('Subscriptions are bought in the iOS app, through the App Store.'))}
          >
            {status.purchasable
              ? t('Start {n}-day free trial', { n: status.trialDays })
              : t('Billing is not switched on yet')}
          </button>
          <p className="foot-note">
            {status.purchasable
              ? t(selected?.perSeat ? 'plans.trial.seat' : 'plans.trial', { days: status.trialDays, price: selected ? price(selected) : '' })
              : t('plans.notForSale', { n: status.dailyLimit })}
          </p>
        </div>
      )}
    </div>
  )
}
