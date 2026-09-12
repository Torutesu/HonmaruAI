import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  onClose: () => void
}

interface Metrics {
  days: number
  cards: number
  pending: number
  decided: number
  selfAddressed: number
  medianMinutesToDecide: number | null
  declineRate: number | null
  nudges: number
  created: Array<{ day: string; count: number }>
  bySource: Array<{ source: string; count: number }>
  byAction: Array<{ action: string; count: number }>
  feedback: { right: number; wrong: number; reasons: Record<string, number> }
}

// English keys, translated where read.
const ACTION_WORD: Record<string, string> = {
  approve: 'Approved', decline: 'Declined', revise: 'Revision asked',
  choose: 'Chose', reply: 'Replied', acknowledge: 'Acknowledged',
  delegate: 'Delegated', later: 'Deferred',
}
const REASON_WORD: Record<string, string> = {
  'wrong-person': 'Wrong person', 'not-a-decision': 'Not a decision',
  'wrong-priority': 'Wrong priority', 'wrong-words': 'Badly written', other: 'Other',
}

function duration(minutes: number | null, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (minutes === null) return '—'
  if (minutes < 60) return t('{n}m', { n: Math.round(minutes) })
  if (minutes < 60 * 24) return t('{n}h', { n: Math.round(minutes / 60) })
  return t('{n}d', { n: Math.round(minutes / (60 * 24)) })
}

/// How the feed is doing for this team: the numbers that say whether
/// decisions move, what gets declined, where cards come from, and what the
/// AI got wrong. Read from the cards themselves, so it is right now and not
/// as of the last time somebody ran a report.
export const Insights: React.FC<Props> = ({ httpBase, orgId, sessionToken, onClose }) => {
  const t = useT()
  const [days, setDays] = useState<7 | 14 | 30>(14)
  const [m, setM] = useState<Metrics | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    setM(null)
    fetch(`${httpBase}/metrics?orgId=${encodeURIComponent(orgId)}&days=${days}`, { headers: { 'x-session-token': sessionToken } })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || t('Could not load the numbers.'))
        return r.json()
      })
      .then((data) => { if (!ignore) setM(data) })
      .catch((err) => { if (!ignore) setError(err instanceof Error ? err.message : String(err)) })
    return () => { ignore = true }
  }, [httpBase, orgId, sessionToken, days])

  const peak = Math.max(1, ...(m?.created.map((d) => d.count) || [1]))
  const wrongTotal = m ? Object.values(m.feedback.reasons).reduce((s, n) => s + n, 0) : 0

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Insights')}</span>
      </div>
      <div className="screen-body">
        <div className="seg" role="tablist" aria-label={t('Window')}>
          {([7, 14, 30] as const).map((d) => (
            <button key={d} role="tab" aria-selected={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
              {t('{n} days', { n: d })}
            </button>
          ))}
        </div>

        {error && <div className="form-error">{error}</div>}
        {!m && !error && <div className="empty">{t('Loading…')}</div>}

        {m && (
          <>
            <div className="profile-stats insights-stats">
              <div><b>{m.cards}</b><span>{t('cards')}</span></div>
              <div><b>{duration(m.medianMinutesToDecide, t)}</b><span>{t('median wait')}</span></div>
              <div><b>{m.declineRate === null ? '—' : `${Math.round(m.declineRate * 100)}%`}</b><span>{t('declined')}</span></div>
            </div>

            <div className="rows-title">{t('Cards per day')}</div>
            <div className="bars" role="img" aria-label={t('Cards created per day over the last {n} days', { n: m.days })}>
              {m.created.map((d) => (
                <div key={d.day} className="bar" title={`${d.day}: ${d.count}`}>
                  <i style={{ height: `${Math.max(2, (d.count / peak) * 100)}%` }} className={d.count === 0 ? 'zero' : ''} />
                </div>
              ))}
            </div>
            <div className="bars-axis"><span>{m.created[0]?.day.slice(5)}</span><span>{m.created[m.created.length - 1]?.day.slice(5)}</span></div>

            <div className="rows-title">{t('Right now')}</div>
            <div className="rows">
              <div className="row static"><span className="row-main">{t('Waiting on someone')}</span><span className="row-value">{m.pending}</span></div>
              <div className="row static"><span className="row-main">{t('Decided in this window')}</span><span className="row-value">{m.decided}</span></div>
              <div className="row static"><span className="row-main">{t('Nudged')}<span className="row-sub">{t('A decision that had to be asked about twice.')}</span></span><span className="row-value">{m.nudges}</span></div>
              <div className="row static"><span className="row-main">{t('Notes to yourself')}<span className="row-sub">{t('Cards you routed to yourself.')}</span></span><span className="row-value">{m.selfAddressed}</span></div>
            </div>

            {m.bySource.length > 0 && (
              <>
                <div className="rows-title">{t('Where cards come from')}</div>
                <BarList rows={m.bySource.map((s) => ({ label: s.source === 'You' ? t('You') : s.source, count: s.count }))} />
              </>
            )}

            {m.byAction.length > 0 && (
              <>
                <div className="rows-title">{t('What was decided')}</div>
                <BarList rows={m.byAction.map((a) => ({ label: t(ACTION_WORD[a.action] || a.action), count: a.count }))} />
              </>
            )}

            <div className="rows-title">{t('What your AI got wrong')}</div>
            {wrongTotal === 0 ? (
              <p className="hint insights-hint">{t('Nobody has flagged a card in this window. "Is this card wrong?" sits under every card.')}</p>
            ) : (
              <BarList rows={Object.entries(m.feedback.reasons).map(([reason, count]) => ({ label: t(REASON_WORD[reason] || reason), count }))} />
            )}
          </>
        )}
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}

/// One hue, thin marks, the number beside each bar: a list you can read
/// without a legend.
const BarList: React.FC<{ rows: Array<{ label: string; count: number }> }> = ({ rows }) => {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <ul className="barlist">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="barlist-label">{r.label}</span>
          <span className="barlist-track"><i style={{ width: `${(r.count / max) * 100}%` }} /></span>
          <span className="barlist-count">{r.count}</span>
        </li>
      ))}
    </ul>
  )
}
