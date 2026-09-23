import React, { useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { AccessCodeError, loadBillingStatus, redeemAccessCode, type BillingStatus } from '../utils/billing'

interface Props {
  httpBase: string
  sessionToken: string
  onClose: () => void
}

// A new account gets a fresh component before rendering, so the previous
// person's access, input, and pending responses cannot leak into this view.
export const Plans: React.FC<Props> = (props) => (
  <AccountPlans key={`${props.httpBase}\0${props.sessionToken}`} {...props} />
)

const AccountPlans: React.FC<Props> = ({ httpBase, sessionToken, onClose }) => {
  const t = useT()
  const [status, setStatus] = useState<BillingStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [checking, setChecking] = useState(true)
  const [reload, setReload] = useState(0)
  const lifecycle = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  const statusLoading = useRef(true)

  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    statusLoading.current = true
    setError(null); setChecking(true)
    loadBillingStatus(httpBase, sessionToken, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setStatus(next) })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load plans.')
      })
      .finally(() => { if (!controller.signal.aborted) { statusLoading.current = false; setChecking(false) } })
    return () => {
      controller.abort()
      if (lifecycle.current === controller) lifecycle.current = null
    }
  }, [httpBase, sessionToken, reload])

  const retryStatus = () => {
    if (statusLoading.current || submitting.current) return
    statusLoading.current = true
    setChecking(true)
    setReload((value) => value + 1)
  }

  const redeem = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const controller = lifecycle.current
    if (!controller || controller.signal.aborted || statusLoading.current || checking || submitting.current || !code.trim()) return
    submitting.current = true
    setRedeeming(true)
    setError(null)
    try {
      const next = await redeemAccessCode(httpBase, sessionToken, code, controller.signal)
      if (controller.signal.aborted) return
      setStatus(next)
      setCode('')
      // GET /billing/status retries the server's pending iPhone sync once.
      if (next.complimentarySyncPending) setReload((value) => value + 1)
    } catch (err) {
      if (controller.signal.aborted) return
      setError(err instanceof Error ? err.message : 'Could not activate free access. Try again.')
      if (err instanceof AccessCodeError && err.status === 503) {
        try {
          const next = await loadBillingStatus(httpBase, sessionToken, controller.signal)
          if (controller.signal.aborted) return
          setStatus(next)
          if (next.complimentary) { setCode(''); setError(null) }
        } catch { /* Keep the original safe error and the status retry action. */ }
      }
    } finally {
      if (!controller.signal.aborted) {
        submitting.current = false
        setRedeeming(false)
      }
    }
  }

  const cancellationNote = t('Free access does not cancel an existing Apple subscription. Cancel it in iPhone Settings → your name → Subscriptions to stop future renewals.')

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Plan and usage')}</span>
      </div>
      <div className="screen-body">
        {error && <div className="form-error" role="alert">{t(error)}</div>}
        {!status && !error && <div className="empty" role="status">{t('Loading…')}</div>}
        {error && !status?.complimentarySyncPending && (
          <button className="btn btn-secondary" disabled={checking || redeeming} onClick={retryStatus}>{t(checking ? 'Checking access…' : 'Try again')}</button>
        )}

        {status && (
          <>
            <section className="plan-card" style={{ cursor: 'default' }} aria-label={t('Current plan')}>
              <div className="plan-head">
                <div>
                  <b>{status.complimentary ? t('Pro · Free access') : status.pro ? 'Pro' : t('Free')}</b>
                  <span className="plan-tagline">
                    {status.complimentary
                      ? t('Lifetime access. No payment or renewal.')
                      : status.pro ? t('Your subscription is active.') : t('Your free daily allowance')}
                  </span>
                </div>
              </div>
              <ul className="plan-features">
                <li>{status.pro
                  ? t('Unlimited AI routing')
                  : t('{n} AI-routed decisions a day', { n: status.dailyLimit })}</li>
                {!status.pro && status.remainingToday !== null && <li>{t('{n} left today', { n: status.remainingToday })}</li>}
              </ul>
              {status.complimentary && <p className="lede" role="status">{t(status.complimentarySyncPending
                ? 'Pro is ready on the web. We are still syncing free access to the iPhone app.'
                : 'Free access is synced. Open the iPhone app and sign in with the same account. The app may take up to 5 minutes to refresh your access.')}</p>}
              {status.complimentarySyncPending && <>
                <p className="form-note">{t('Your free access is saved. You do not need to enter the code again. Retry to sync iPhone access.')}</p>
                <button className="btn btn-secondary" disabled={checking || redeeming} onClick={retryStatus}>{t(checking ? 'Checking access…' : 'Retry iPhone sync')}</button>
              </>}
            </section>

            {status.complimentary ? (
              <p className="form-note" role="status">{cancellationNote}</p>
            ) : (
              <section aria-label={t('App Store subscription')}>
                <div className="rows-title">{t('App Store subscription')}</div>
                <p className="lede">
                  {status.pro
                    ? t('Manage or cancel your subscription in iPhone Settings → your name → Subscriptions.')
                    : t('To subscribe, open the iOS app and go to You → Plan and usage → Upgrade to Pro. Prices, renewal periods, and any eligible offers are shown by the App Store before you confirm.')}
                </p>
                {!status.pro && status.purchasable && (
                  <>
                    <a className="btn btn-primary" href="https://apps.apple.com/jp/app/honmaruai/id6799302006" target="_blank" rel="noopener noreferrer">
                      {t('Open in the App Store')}
                    </a>
                    <p className="foot-note">{t('Sign in to the iOS app with the same account you use here.')}</p>
                  </>
                )}
                {!status.pro && !status.purchasable && <p className="form-note">{t('Paid upgrades are currently unavailable. You can continue with the free plan.')}</p>}
              </section>
            )}

            {!status.complimentary && status.complimentaryAvailable && (
              <form onSubmit={redeem} aria-label={t('Activate free access')} style={{ marginTop: 24 }}>
                <div className="rows-title">{t('Have an access code?')}</div>
                <p className="lede">{t('Activate lifetime Pro access for this account. No payment details or automatic renewal.')}</p>
                <div className="field">
                  <label htmlFor="complimentary-access-code">{t('Access code')}</label>
                  <input
                    id="complimentary-access-code"
                    type="password"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={128}
                    value={code}
                    disabled={redeeming || checking}
                    onChange={(event) => setCode(event.target.value)}
                    aria-describedby="access-code-note"
                  />
                </div>
                <p id="access-code-note" className="form-note">{cancellationNote}</p>
                <button className="btn btn-primary" disabled={redeeming || checking || !code.trim()} type="submit">
                  {redeeming ? t('Activating…') : t('Activate free access')}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  )
}
