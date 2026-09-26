import React, { useEffect, useState } from 'react'
import { enableWebPush, disableWebPush, pushSupport, currentSubscription } from '../utils/push'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'
import { setQuietState, DEFAULT_SCHEDULE, tomorrowAt, type NotifySchedule } from '../utils/quiet'
import { playSound, loadSoundSettings, saveSoundSettings, type SoundKind, type SoundSettings } from '../utils/sound'

interface Props {
  httpBase: string
  sessionToken: string
  onClose: () => void
}

interface Me {
  email: string | null
  emailEditable: boolean
  notifyEmail: boolean
  pushWhileActive?: boolean
  notifyPausedUntil?: string | null
  notifySchedule?: NotifySchedule
  locale: string
}

/// Where a decision reaches you when the app is not open.
///
/// Three channels, one rule: email is the floor, and it only carries a
/// decision when no push channel could. Saying that on the screen is the
/// difference between "why am I getting email?" and "of course I am".
export const NotificationSettings: React.FC<Props> = ({ httpBase, sessionToken, onClose }) => {
  const t = useT()
  const [me, setMe] = useState<Me | null>(null)
  const [pushOn, setPushOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const support = pushSupport()

  useEffect(() => {
    fetch(`${httpBase}/me`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => r.json())
      .then((data) => { setMe(data); setEmail(data.email || '') })
      .catch(() => setError(t('Could not read your settings.')))
    currentSubscription().then((sub) => setPushOn(Boolean(sub)))
  }, [httpBase, sessionToken])

  const togglePush = async () => {
    setBusy(true); setError(null)
    try {
      if (pushOn) {
        await disableWebPush(httpBase, sessionToken)
        setPushOn(false)
      } else {
        const result = await enableWebPush(httpBase, sessionToken)
        if (result === 'denied') { setError(t('Your browser refused. Allow notifications for this site, then try again.')); return }
        if (result === 'unavailable') { setError(t('This browser cannot receive push notifications here.')); return }
        setPushOn(true)
      }
    } finally { setBusy(false) }
  }

  const patch = async (body: Record<string, unknown>) => {
    setError(null)
    const res = await fetch(`${httpBase}/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.message || t('That did not save.')); return false }
    setMe((prev) => (prev ? { ...prev, ...data } : prev))
    if ('notifyPausedUntil' in data || 'notifySchedule' in data) setQuietState({ pausedUntil: data.notifyPausedUntil ?? null, schedule: data.notifySchedule ?? null })
    return true
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Notifications')}</span>
      </div>
      <div className="screen-body">
        {error && <div className="form-error">{error}</div>}

        <div className="rows-title">{t('On this device')}</div>
        <div className="rows">
          <div className="row static">
            <span className="row-icon"><Icon name="bell" size={18} /></span>
            <span className="row-main">
              {t('Push notifications')}
              <span className="row-sub">
                {support === 'needs-install'
                  ? t('On iPhone, add this to your home screen first — Safari only allows notifications for an installed web app.')
                  : support === 'unsupported'
                    ? t('This browser cannot receive them.')
                    : support === 'denied'
                      ? t('Blocked in your browser settings — allow notifications for this site to turn it on.')
                      : t('A decision that needs you arrives even when this tab is closed.')}
              </span>
            </span>
            <button
              className="switch"
              role="switch"
              aria-checked={pushOn}
              aria-label={t('Push notifications')}
              disabled={busy || support !== 'ready'}
              onClick={togglePush}
            />
          </div>
        </div>

        <div className="rows">
          <div className="row static">
            <span className="row-icon"><Icon name="monitor" size={18} /></span>
            <span className="row-main">
              {t('Push to my phone while I use a computer')}
              <span className="row-sub">{t('Off: while you are using HonmaruAI somewhere, your phone stays quiet, and a message you have not read reaches it after a minute.')}</span>
            </span>
            <button
              className="switch"
              role="switch"
              aria-checked={Boolean(me?.pushWhileActive)}
              aria-label={t('Push to my phone while I use a computer')}
              disabled={!me}
              onClick={() => patch({ pushWhileActive: !me?.pushWhileActive })}
              data-push-active="1"
            />
          </div>
        </div>

        <QuietRows me={me} patch={patch} />

        <SoundRows />

        <div className="rows-title">{t('By email')}</div>
        <div className="rows">
          <div className="row static">
            <span className="row-icon"><Icon name="mail" size={18} /></span>
            <span className="row-main">
              {t('Email as the fallback')}
              <span className="row-sub">{t('Only when no device of yours can be reached. Never a duplicate.')}</span>
            </span>
            <button
              className="switch"
              role="switch"
              aria-checked={Boolean(me?.notifyEmail)}
              aria-label={t('Email fallback')}
              disabled={!me}
              onClick={() => patch({ notifyEmail: !me?.notifyEmail })}
            />
          </div>
        </div>

        {me && (
          <div className="field">
            <label htmlFor="notify-email">{t('Where it goes')}</label>
            <input
              id="notify-email"
              type="email"
              value={email}
              disabled={!me.emailEditable}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => { if (me.emailEditable && email !== (me.email || '')) patch({ email }) }}
              placeholder={t('you@company.com')}
            />
            <div className="hint">
              {me.emailEditable
                ? t('Changing this changes nothing else — it is only where mail lands.')
                : t('This is the address you sign in with, so it cannot be changed here.')}
            </div>
          </div>
        )}

        <p className="lede" style={{ fontSize: 13.5, marginTop: 20 }}>
          {t('notify.language')}
        </p>
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}

/// Sounds, on this device: all of them at once, how loud, and which kinds —
/// each with a ▶ to hear it before choosing.
const SoundRows: React.FC = () => {
  const t = useT()
  const [s, setS] = useState<SoundSettings>(() => loadSoundSettings())
  const set = (patch: Partial<SoundSettings>) => { const next = { ...s, ...patch }; setS(next); saveSoundSettings(next) }
  const kinds: Array<{ key: keyof SoundSettings; label: string; sub: string; sample: SoundKind }> = [
    { key: 'mentions', label: t('Direct messages and mentions'), sub: t('A knock when someone writes to you or @names you.'), sample: 'mention' },
    { key: 'decisions', label: t('A decision for you'), sub: t('A chime when a decision lands in your feed.'), sample: 'decision' },
    { key: 'channels', label: t('Every channel message'), sub: t('A soft drop for channels you have not muted. Off unless you want it.'), sample: 'message' },
    { key: 'inConversation', label: t('In the conversation you are in'), sub: t('A tick, barely there, when you are already looking.'), sample: 'inConversation' },
    { key: 'sent', label: t('Sending a direct message'), sub: t('A small swish when yours goes.'), sample: 'sent' },
    { key: 'jam', label: t('Jams'), sub: t('Someone joining or leaving, and the ring when you are called.'), sample: 'ring' },
  ]
  return (
    <>
      <div className="rows-title">{t('Sounds')}</div>
      <div className="rows sound-rows">
        <div className="row static">
          <span className="row-icon"><Icon name="bell" size={18} /></span>
          <span className="row-main">
            {t('Play sounds')}
            <span className="row-sub">{t('On this device only. With the app open in several tabs, one of them plays.')}</span>
            {s.enabled && (
              <span className="sound-volume">
                <input type="range" min={0} max={1} step={0.05} value={s.volume} aria-label={t('Volume')}
                  onChange={(e) => set({ volume: Number(e.target.value) })} onMouseUp={() => playSound('mention', { preview: true })} onTouchEnd={() => playSound('mention', { preview: true })} />
              </span>
            )}
          </span>
          <button className="switch" role="switch" aria-checked={s.enabled} aria-label={t('Play sounds')} onClick={() => set({ enabled: !s.enabled })} data-sounds="1" />
        </div>
        {s.enabled && kinds.map((k) => (
          <div className="row static" key={k.key}>
            <button type="button" className="row-icon sound-preview" onClick={() => playSound(k.sample, { preview: true })} aria-label={t('Play {name}', { name: k.label })}>
              <Icon name="send" size={14} />
            </button>
            <span className="row-main">{k.label}<span className="row-sub">{k.sub}</span></span>
            <button className="switch" role="switch" aria-checked={Boolean(s[k.key])} aria-label={k.label} onClick={() => set({ [k.key]: !s[k.key] } as Partial<SoundSettings>)} />
          </div>
        ))}
      </div>
    </>
  )
}

/// Pause notifications for a while, and the hours they may come at all.
/// While paused or outside the hours, nothing reaches your phone, browser or
/// inbox; it all waits in Activity.
const QuietRows: React.FC<{ me: Me | null; patch: (body: Record<string, unknown>) => Promise<boolean> }> = ({ me, patch }) => {
  const t = useT()
  const locale = typeof navigator !== 'undefined' ? navigator.language : 'en'
  const paused = me?.notifyPausedUntil && Date.parse(me.notifyPausedUntil) > Date.now() ? me.notifyPausedUntil : null
  const schedule = me?.notifySchedule || DEFAULT_SCHEDULE
  const setSchedule = (next: Partial<NotifySchedule>) => void patch({ notifySchedule: { ...schedule, ...next } })
  const DAYS = [1, 2, 3, 4, 5, 6, 0]
  const dayName = (d: number) => new Date(2026, 8, 20 + d).toLocaleDateString(locale, { weekday: 'short' })
  return (
    <>
      <div className="rows-title">{t('Pause notifications')}</div>
      <div className="rows">
        <div className="row static quiet-row">
          <span className="row-icon"><Icon name="bell-off" size={18} /></span>
          <span className="row-main">
            {paused ? t('Paused until {when}', { when: new Date(paused).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) }) : t('Notifications are on')}
            <span className="row-sub">{t('While paused, nothing reaches your phone, browser or inbox. It all waits in Activity.')}</span>
            <span className="quiet-choices">
              {paused
                ? <button type="button" className="pill-btn" disabled={!me} onClick={() => void patch({ pausedUntil: null })} data-resume-settings="1">{t('Resume now')}</button>
                : ([[30, t('30 minutes')], [60, t('1 hour')], [120, t('2 hours')]] as Array<[number, string]>).map(([m, label]) => (
                  <button key={m} type="button" className="quiet-choice" disabled={!me} onClick={() => void patch({ pauseMinutes: m })} data-pause={m}>{label}</button>
                ))}
              {!paused && <button type="button" className="quiet-choice" disabled={!me} onClick={() => void patch({ pausedUntil: tomorrowAt(9) })} data-pause="tomorrow">{t('Until tomorrow 9:00')}</button>}
            </span>
          </span>
        </div>
      </div>

      <div className="rows-title">{t('Notification hours')}</div>
      <div className="rows">
        <div className="row static">
          <span className="row-icon"><Icon name="clock" size={18} /></span>
          <span className="row-main">
            {t('Only notify me during these hours')}
            <span className="row-sub">{t('In your own time zone. Outside them it is quiet, as if paused.')}</span>
          </span>
          <button className="switch" role="switch" aria-checked={schedule.enabled} aria-label={t('Only notify me during these hours')} disabled={!me} onClick={() => setSchedule({ enabled: !schedule.enabled })} data-schedule="1" />
        </div>
        {schedule.enabled && (
          <div className="row static quiet-hours">
            <span className="quiet-days" role="group" aria-label={t('Days')}>
              {DAYS.map((d) => (
                <button key={d} type="button" className={`quiet-day${schedule.days.includes(d) ? ' on' : ''}`} aria-pressed={schedule.days.includes(d)}
                  onClick={() => setSchedule({ days: schedule.days.includes(d) ? schedule.days.filter((x) => x !== d) : [...schedule.days, d] })}>
                  {dayName(d)}
                </button>
              ))}
            </span>
            <span className="quiet-times">
              <input type="time" value={schedule.from} aria-label={t('From')} onChange={(e) => e.target.value && setSchedule({ from: e.target.value })} data-schedule-from="1" />
              <span>–</span>
              <input type="time" value={schedule.to} aria-label={t('To')} onChange={(e) => e.target.value && setSchedule({ to: e.target.value })} data-schedule-to="1" />
            </span>
          </div>
        )}
      </div>
    </>
  )
}
