import React, { useState, useEffect, useRef } from 'react'
import { browserLanguage } from '../utils/locale'
import { LanguageOptions } from '../components/LanguageOptions'
import { changeLocale, useT } from '../utils/i18n'
import { readOnboardingDraft } from '../utils/onboardingProgress'
import { defaultDailySetup, dailyWanted, NEW_CHANNEL, type DailySetup } from '../utils/dailySetup'
import { localTimeZone, parseTime, timeValue } from '../utils/automation'
import type { Business } from '../types/card'
import { Icon } from '../components/Icon'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  progressKey: string
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
/// behaves from the first card — what you do, and what language you read —
/// and the daily report: when your AI drafts your morning plan and your
/// evening report, and where you post them. On by default at 08:00 and
/// 22:00 where you are; either can be moved or switched off here, and all of
/// it changed later under Automations.
///
/// Everything else the product could ask for — your businesses, your team,
/// your tools — it learns by being used, which is the whole design. Asking on
/// day one produces a taxonomy nobody will keep.
export const Onboarding: React.FC<Props> = ({ httpBase, orgId, sessionToken, progressKey, onDone }) => {
  const t = useT()
  const [saved] = useState(() => readOnboardingDraft(localStorage, progressKey))
  const [page, setPage] = useState(saved.page || 0)
  const [role, setRole] = useState(saved.role || 'founder')
  // The browser's language, whichever it is: a reader of a language the
  // screens are not translated into still reads their cards and
  // notifications in it, and defaulting them to English undid that.
  const [locale, setLocale] = useState(() => saved.locale || browserLanguage())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [demo, setDemo] = useState<null | 'approved' | 'declined'>(null)
  // The workspace's channels, for where the daily report goes; and the
  // setup itself, once there is a list to default from.
  const [businesses, setBusinesses] = useState<Business[] | null>(null)
  const [daily, setDaily] = useState<DailySetup | null>(saved.daily || null)
  useEffect(() => {
    let ignore = false
    fetch(`${httpBase}/businesses?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => (r.ok ? r.json() : { businesses: [] }))
      .then((data) => { if (!ignore) setBusinesses(data.businesses || []) })
      .catch(() => { if (!ignore) setBusinesses([]) })
    return () => { ignore = true }
  }, [httpBase, orgId, sessionToken])
  useEffect(() => {
    if (businesses && !daily) setDaily(defaultDailySetup(businesses, t('daily-reports')))
  }, [businesses, daily, t])

  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => { try { localStorage.setItem(`${progressKey}:draft`, JSON.stringify({ page, role, locale, ...(daily ? { daily } : {}) })) } catch { /* In-memory progress still works. */ } }, [progressKey, page, role, locale, daily])

  const headers = { 'content-type': 'application/json', 'x-session-token': sessionToken }
  /// The daily report, made: its channel if it is new, then the morning and
  /// evening routines this person does not already have — so finishing
  /// onboarding a second time, on another browser, does not make two of each.
  const setUpDaily = async (signal: AbortSignal) => {
    if (!daily || !dailyWanted(daily)) return
    let channel = daily.channel
    if (channel === NEW_CHANNEL) {
      const res = await fetch(`${httpBase}/businesses`, { method: 'POST', signal, headers, body: JSON.stringify({ orgId, name: daily.newName.trim() }) })
      const data = await res.json().catch(() => ({}))
      // A guest may not make channels: their report goes to one they were
      // let into, or is left for later — never a wall at the last step.
      if (res.status === 403) {
        const first = (businesses || [])[0]
        if (!first) return
        channel = `b:${first.slug}`
      } else {
        if (!res.ok || !data.business?.slug) throw new Error(data.message || t('We could not save that.'))
        channel = `b:${data.business.slug}`
      }
    }
    const list = await fetch(`${httpBase}/routines?orgId=${encodeURIComponent(orgId)}`, { signal, headers })
    const have = new Set<string>(((await list.json().catch(() => ({}))).routines || []).map((r: { kind: string }) => r.kind))
    const wanted = [
      ...(daily.morning.on && !have.has('daily_plan') ? [{ kind: 'daily_plan', ...daily.morning }] : []),
      ...(daily.evening.on && !have.has('daily_report') ? [{ kind: 'daily_report', ...daily.evening }] : []),
    ]
    for (const w of wanted) {
      const res = await fetch(`${httpBase}/routines`, {
        method: 'POST', signal, headers,
        body: JSON.stringify({ orgId, kind: w.kind, cadence: daily.cadence, hour: w.hour, minute: w.minute, timezone: localTimeZone(), channel, recipient: 'me' }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || t('We could not save that.'))
    }
  }
  const finish = async () => {
    if (request.current) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${httpBase}/me`, {
        method: 'PUT', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ locale, role, orgId }),
      })
      if (!res.ok) { if (!controller.signal.aborted) setError(t('We could not save that.')); return }
      if (controller.signal.aborted) return
      await setUpDaily(controller.signal)
      if (controller.signal.aborted) return
      changeLocale(locale); onDone()
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error && err.message ? err.message : t('We could not save that.'))
    } finally {
      if (!controller.signal.aborted) { request.current = null; setBusy(false) }
    }
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
          <button className="ob-round no" onClick={() => setDemo('declined')} disabled={!!demo} aria-label={t('Decline')}><Icon name="x" size={22} /></button>
          <button className="ob-round yes" onClick={() => setDemo('approved')} disabled={!!demo} aria-label={t('Approve')}><Icon name="check" size={22} /></button>
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

  if (page > pages.length) {
    const slotRow = (key: 'morning' | 'evening', label: string, sub: string) => {
      const value = daily ? daily[key] : null
      if (!daily || !value) return null
      return (
        <div className="auto-field daily-part" data-part={key}>
          <label className="daily-toggle">
            <input type="checkbox" checked={value.on} disabled={busy} onChange={(e) => setDaily({ ...daily, [key]: { ...value, on: e.target.checked } })} />
            <span>{label}<span className="row-sub daily-part-sub">{sub}</span></span>
          </label>
          <input
            type="time"
            className="row-select"
            value={timeValue(value.hour, value.minute)}
            disabled={busy || !value.on}
            onChange={(e) => { const time = parseTime(e.target.value); if (time) setDaily({ ...daily, [key]: { ...value, ...time } }) }}
            aria-label={label}
          />
        </div>
      )
    }
    const zone = localTimeZone()
    return (
      <div className="screen">
        <div className="screen-head">
          <button className="back" disabled={busy} onClick={() => setPage(pages.length)} aria-label={t('Back')}>‹</button>
          <span className="head-title">{t('Daily report')}</span>
        </div>
        <div className="screen-body ob-daily">
          <h1 className="display" style={{ fontSize: 28 }}>{t('When should your AI draft your daily report?')}</h1>
          <p className="lede">{t('Morning: today’s plan. Evening: how the day went. Your AI writes it in your own words from your day and tells you when it is ready; you check it and post it. Nothing goes out until you do.')}</p>
          {!daily ? (
            <div className="empty">{t('Loading…')}</div>
          ) : (
            <>
              {slotRow('morning', t('Morning — today’s plan'), t('What you will do today, where your tasks stand, where you need help.'))}
              {slotRow('evening', t('Evening — how the day went'), t('What you did, what went well, what to improve, tomorrow.'))}
              <div className="auto-field">
                <span className="auto-label">{t('When')}</span>
                <select className="row-select" value={daily.cadence} disabled={busy} onChange={(e) => setDaily({ ...daily, cadence: e.target.value === 'daily' ? 'daily' : 'weekdays' })} aria-label={t('How often')}>
                  <option value="weekdays">{t('Every weekday')}</option>
                  <option value="daily">{t('Every day')}</option>
                </select>
              </div>
              <div className="auto-field">
                <span className="auto-label">{t('Post to')}</span>
                <select className="row-select" value={daily.channel} disabled={busy} onChange={(e) => setDaily({ ...daily, channel: e.target.value })} aria-label={t('Post to')}>
                  {(businesses || []).map((b) => <option key={b.slug} value={`b:${b.slug}`}>#{b.slug}{b.name && b.name !== b.slug ? ` — ${b.name}` : ''}</option>)}
                  <option value={NEW_CHANNEL}>{t('A new channel…')}</option>
                </select>
              </div>
              {daily.channel === NEW_CHANNEL && (
                <div className="auto-field">
                  <span className="auto-label">{t('Name')}</span>
                  <input className="ai-key-input" value={daily.newName} maxLength={60} disabled={busy} onChange={(e) => setDaily({ ...daily, newName: e.target.value })} aria-label={t('New channel name')} />
                </div>
              )}
              <p className="hint">{t('Times are where you are ({zone}). You can change all of this later under Automations.', { zone })}</p>
            </>
          )}
          {error && <div className="form-error" role="alert">{error}</div>}
          <div style={{ height: 8 }} />
        </div>
        <div className="screen-foot bare">
          <button className="btn btn-primary" onClick={finish} disabled={busy || !daily}>
            {busy ? t('Saving…') : t('Open my feed')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" disabled={busy} onClick={() => setPage(pages.length - 1)} aria-label={t('Back')}>‹</button>
        <span className="head-title">{t('Two questions')}</span>
      </div>
      <div className="screen-body">
        <h1 className="display" style={{ fontSize: 28 }}>{t('What do you mostly decide?')}</h1>
        <p className="lede">{t('Your AI routes by role. This is the only thing it cannot guess on day one.')}</p>

        <div className="rows">
          {ROLES.map((r) => (
            <button key={r.id} className="row" disabled={busy} onClick={() => setRole(r.id)} aria-pressed={role === r.id}>
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
          <select disabled={busy} value={locale} onChange={(e) => setLocale(e.target.value)} aria-label={t('Language')}>
            <LanguageOptions current={locale} />
          </select>
          <div className="hint">{t('Every notification reaches you in this language, whoever wrote it.')}</div>
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}
        <div style={{ height: 8 }} />
      </div>
      <div className="screen-foot bare">
        <button className="btn btn-primary" onClick={() => setPage(pages.length + 1)} disabled={busy}>
          {t('Next')}
        </button>
      </div>
    </div>
  )
}
