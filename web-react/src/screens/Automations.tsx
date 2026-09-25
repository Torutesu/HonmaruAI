import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'
import { Icon } from '../components/Icon'
import { ago } from '../utils/ago'
import {
  CADENCES, draftFromRoutine, emptyDraft, localTimeZone, money, parseTime, routineBody, timeValue, weekdayNames,
  type Routine, type RoutineDraft,
} from '../utils/automation'
import type { Business, Cadence } from '../types/card'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  /// A run just delivered a card: go and read it.
  onOpenCard: (cardId: string) => void
  onClose: () => void
}

interface Member { ref: string; name: string; mine: boolean }

// English keys, translated where read.
const CADENCE_WORD: Record<Cadence, string> = {
  daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month',
}

/// Automations: work your AI does on a schedule, delivered to the feed as a
/// card. One sentence makes one — "every Monday at 9, summarise last week" —
/// read by the Worker's parser as you type, and shown back as the schedule it
/// understood, which you can correct before anything is saved.
///
/// What each run cost sits beside it. An assistant whose bill you cannot
/// predict is one people switch off.
export const Automations: React.FC<Props> = ({ httpBase, orgId, sessionToken, onOpenCard, onClose }) => {
  const t = useT()
  const locale = getLocale()
  const [routines, setRoutines] = useState<Routine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  // The sentence, and what the parser made of it. Once the person touches a
  // control, the parser stops overwriting that part: they have said it better.
  const [say, setSay] = useState('')
  const [draft, setDraft] = useState<RoutineDraft>(emptyDraft)
  const [understood, setUnderstood] = useState<boolean | null>(null)
  const scheduleTouched = useRef(false)
  const instructionTouched = useRef(false)
  const [creating, setCreating] = useState(false)
  // One routine at a time is edited, run, or about to be deleted.
  const [editing, setEditing] = useState<{ id: string; draft: RoutineDraft } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // The daily report, being set up: which days, which channel, and the
  // morning and evening times — each the person's own to move or turn off.
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [daily, setDaily] = useState<DailySetupDraft | null>(null)

  const headers = useMemo(() => ({ 'content-type': 'application/json', 'x-session-token': sessionToken }), [sessionToken])
  const call = useCallback(async (method: string, path: string, body?: Record<string, unknown>) => {
    const res = await fetch(`${httpBase}${path}`, { method, headers, body: body ? JSON.stringify({ orgId, ...body }) : undefined })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.message || t('That did not save.'))
    return data
  }, [httpBase, headers, orgId, t])

  useEffect(() => {
    let ignore = false
    fetch(`${httpBase}/routines?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data.message || t('Could not load your automations.'))
        return data
      })
      .then((data) => { if (!ignore) setRoutines(data.routines || []) })
      .catch((err) => { if (!ignore) { setRoutines([]); setError(err instanceof Error ? err.message : String(err)) } })
    fetch(`${httpBase}/members?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((data) => { if (!ignore) setMembers(data.members || []) })
      .catch(() => { /* the report goes to you, which needs no list */ })
    fetch(`${httpBase}/businesses?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => (r.ok ? r.json() : { businesses: [] }))
      .then((data) => { if (!ignore) setBusinesses(data.businesses || []) })
      .catch(() => { /* no channels to offer: the daily report says so */ })
    return () => { ignore = true }
  }, [httpBase, orgId, sessionToken, t])

  // The parser, a beat after typing stops. It is local to the Worker and
  // costs nothing, so it is asked on every pause, not on a button.
  useEffect(() => {
    const text = say.trim()
    if (!text) { setUnderstood(null); return }
    let ignore = false
    const id = setTimeout(async () => {
      let parsed: null | { cadence: Cadence; weekday?: number | null; monthday?: number | null; hour: number; minute?: number; instruction?: string } = null
      try {
        const res = await fetch(`${httpBase}/routines/parse`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text, locale: locale.startsWith('ja') ? 'ja' : 'en' }),
        })
        if (res.ok) parsed = (await res.json()).parsed ?? null
      } catch { /* read as an instruction with no schedule */ }
      if (ignore) return
      setUnderstood(Boolean(parsed))
      setDraft((d) => {
        const next = { ...d }
        if (parsed && !scheduleTouched.current) {
          next.cadence = parsed.cadence
          if (parsed.weekday != null) next.weekday = parsed.weekday
          if (parsed.monthday != null) next.monthday = parsed.monthday
          next.hour = parsed.hour
          next.minute = parsed.minute ?? 0
        }
        if (!instructionTouched.current) next.instruction = (parsed?.instruction || '').trim() || text
        return next
      })
    }, 300)
    return () => { ignore = true; clearTimeout(id) }
  }, [say, httpBase, headers, locale])

  const resetComposer = () => {
    setSay('')
    setDraft(emptyDraft())
    setUnderstood(null)
    scheduleTouched.current = false
    instructionTouched.current = false
  }

  const create = async (body: Record<string, unknown>) => {
    setCreating(true); setError(null)
    try {
      const data = await call('POST', '/routines', body)
      setRoutines((list) => [data.routine, ...(list || [])])
      resetComposer()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setCreating(false) }
  }

  const replace = (routine: Routine) => setRoutines((list) => (list || []).map((r) => (r.id === routine.id ? routine : r)))
  const act = async (id: string, work: () => Promise<void>) => {
    setBusy(id); setError(null)
    try { await work() } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(null) }
  }
  const toggle = (r: Routine) => act(r.id, async () => {
    replace((await call('PUT', `/routines/${encodeURIComponent(r.id)}`, { enabled: !r.enabled })).routine)
  })
  const runNow = (r: Routine) => act(r.id, async () => {
    const data = await call('POST', `/routines/${encodeURIComponent(r.id)}/run`, {})
    if (data.routine) replace(data.routine)
    if (data.cardId) onOpenCard(data.cardId)
  })
  const save = (id: string, next: RoutineDraft) => act(id, async () => {
    replace((await call('PUT', `/routines/${encodeURIComponent(id)}`, routineBody(next))).routine)
    setEditing(null)
  })
  const remove = (r: Routine) => act(r.id, async () => {
    const res = await fetch(`${httpBase}/routines/${encodeURIComponent(r.id)}?orgId=${encodeURIComponent(orgId)}`, { method: 'DELETE', headers })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || t('That did not work. Try again in a moment.'))
    setRoutines((list) => (list || []).filter((x) => x.id !== r.id))
    setConfirm(null)
  })

  const hasBrief = (routines || []).some((r) => r.kind === 'brief')
  const hasPlan = (routines || []).some((r) => r.kind === 'daily_plan')
  const hasReport = (routines || []).some((r) => r.kind === 'daily_report')
  // 08:00 and 22:00 where the person is, unless they say otherwise; only
  // the half they do not have yet.
  const openDaily = () => setDaily({
    cadence: 'weekdays',
    channel: businesses[0] ? `b:${businesses[0].slug}` : '',
    morning: { on: !hasPlan, hour: 8, minute: 0 },
    evening: { on: !hasReport, hour: 22, minute: 0 },
  })
  const createDaily = async () => {
    if (!daily?.channel) return
    const wanted = [
      ...(daily.morning.on && !hasPlan ? [{ kind: 'daily_plan', ...daily.morning }] : []),
      ...(daily.evening.on && !hasReport ? [{ kind: 'daily_report', ...daily.evening }] : []),
    ]
    if (!wanted.length) return
    setCreating(true); setError(null)
    try {
      const made: Routine[] = []
      for (const w of wanted) {
        const data = await call('POST', '/routines', {
          kind: w.kind, cadence: daily.cadence, hour: w.hour, minute: w.minute, timezone: localTimeZone(), channel: daily.channel, recipient: 'me',
        })
        made.push(data.routine)
      }
      setRoutines((list) => [...made, ...(list || [])])
      setDaily(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setCreating(false) }
  }
  const composing = say.trim().length > 0
  const next = (iso: string) => new Date(iso).toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  // Paused or when next, then the last run and what it cost — joined by
  // dots, the way every other line under a row is.
  const times = (r: Routine): React.ReactNode[] => {
    const parts: React.ReactNode[] = []
    if (!r.enabled) parts.push(t('Paused'))
    else if (r.nextRunAt) parts.push(t('Next: {when}', { when: next(r.nextRunAt) }))
    if (r.lastRunAt) parts.push(t('Last run {when}', { when: ago(r.lastRunAt) }))
    if (r.lastRunAt && r.lastUsd !== null && !r.lastError) parts.push(<span className="routine-cost" key="usd">{money(r.lastUsd)}</span>)
    return parts.flatMap((p, i) => (i ? [' · ', p] : [p]))
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Automations')}</span>
      </div>
      <div className="screen-body">
        <p className="lede" style={{ marginTop: 8 }}>{t('automations.lede')}</p>

        <div className={`auto-compose${composing ? ' open' : ''}`}>
          <label className="auto-question" htmlFor="auto-say">{t('What should your AI do, and when?')}</label>
          <textarea
            id="auto-say"
            className="auto-say"
            rows={2}
            value={say}
            maxLength={2000}
            onChange={(e) => setSay(e.target.value)}
            placeholder={t('automations.placeholder')}
          />
          {composing && (
            <div className="auto-understood">
              <DraftFields
                draft={draft}
                members={members}
                onChange={(patch, part) => {
                  if (part === 'schedule') scheduleTouched.current = true
                  if (part === 'instruction') instructionTouched.current = true
                  setDraft((d) => ({ ...d, ...patch }))
                }}
              />
              {understood === false && (
                <p className="auto-hint">{t('No time in that yet. Say one — “every weekday at 8”, “the 1st of every month” — or set it here.')}</p>
              )}
              <div className="auto-actions">
                <button type="button" className="btn-text" onClick={resetComposer}>{t('Clear')}</button>
                <button
                  type="button"
                  className="pill-btn"
                  disabled={creating || !draft.instruction.trim()}
                  onClick={() => create({ kind: 'report', ...routineBody(draft) })}
                >
                  {creating ? t('Creating…') : t('Create')}
                </button>
              </div>
            </div>
          )}
        </div>

        {!hasBrief && routines !== null && (
          <div className="rows">
            <button
              className="row auto-preset"
              disabled={creating}
              onClick={() => create({ kind: 'brief', cadence: 'weekdays', hour: 8, minute: 0, timezone: localTimeZone(), recipient: 'me' })}
            >
              <span className="row-icon"><Icon name="calendar" size={18} /></span>
              <span className="row-main">
                {t('Morning brief')}
                <span className="row-sub">{t('Weekdays at 08:00: what waits on you, what is stuck, what was decided yesterday.')}</span>
              </span>
              <span className="pill-tag">{t('Add')}</span>
            </button>
          </div>
        )}

        {!(hasPlan && hasReport) && routines !== null && (
          daily ? (
            <div className="auto-compose open daily-setup">
              <span className="auto-question">{t('Daily report')}</span>
              <p className="auto-hint">{t('Your AI drafts it in your own words at these times and tells you it is ready. Nothing is posted until you check it and press Post.')}</p>
              <DailySetup draft={daily} businesses={businesses} hasPlan={hasPlan} hasReport={hasReport} onChange={(patch) => setDaily((d) => (d ? { ...d, ...patch } : d))} />
              <div className="auto-actions">
                <button type="button" className="btn-text" onClick={() => setDaily(null)}>{t('Cancel')}</button>
                <button type="button" className="pill-btn" disabled={creating || !daily.channel || !((daily.morning.on && !hasPlan) || (daily.evening.on && !hasReport))} onClick={createDaily}>
                  {creating ? t('Creating…') : t('Create')}
                </button>
              </div>
            </div>
          ) : (
            <div className="rows">
              <button className="row auto-preset" disabled={creating} onClick={openDaily}>
                <span className="row-icon"><Icon name="send" size={18} /></span>
                <span className="row-main">
                  {t('Daily report')}
                  <span className="row-sub">{t('Morning: today’s plan. Evening: how the day went — what went well, what to improve, tomorrow. In your own words, at times you choose, for you to check and post.')}</span>
                </span>
                <span className="pill-tag">{t('Add')}</span>
              </button>
            </div>
          )
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="rows-title">{t('Your automations')}</div>
        {routines === null && <div className="empty">{t('Loading…')}</div>}
        {routines !== null && routines.length === 0 && (
          <div className="empty auto-empty">{t('Nothing runs on a schedule yet. Say what you want above, and when — the result arrives in your feed as a card.')}</div>
        )}
        {routines !== null && routines.length > 0 && (
          <div className="rows">
            {routines.map((r) => (
              editing?.id === r.id ? (
                <div className="row static routine-row editing" key={r.id} data-routine={r.id}>
                  <div className="routine-edit">
                    {r.kind === 'daily_report' || r.kind === 'daily_plan' ? (
                      <DailyFields
                        draft={editing.draft}
                        businesses={businesses}
                        onChange={(patch) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e))}
                      />
                    ) : (
                      <DraftFields
                        draft={editing.draft}
                        members={members}
                        withTitle
                        recipientName={r.recipient.name}
                        onChange={(patch) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e))}
                      />
                    )}
                    <div className="auto-actions">
                      <button type="button" className="btn-text" onClick={() => setEditing(null)}>{t('Cancel')}</button>
                      <button type="button" className="pill-btn" disabled={busy === r.id || !editing.draft.instruction.trim()} onClick={() => save(r.id, editing.draft)}>
                        {t('Save')}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className={`row static routine-row${r.enabled ? '' : ' off'}`} key={r.id} data-routine={r.id}>
                  <span className="row-icon"><Icon name={r.kind === 'brief' ? 'calendar' : r.kind === 'daily_report' || r.kind === 'daily_plan' ? 'send' : 'repeat'} size={18} /></span>
                  <span className="row-main">
                    <span className="routine-title">{r.title}</span>
                    <span className="row-sub">
                      {r.schedule}
                      {!r.recipient.self && ` · ${t('to {name}', { name: r.recipient.name })}`}
                      {r.channel && ` · ${t('posted to {channel}', { channel: `#${r.channel.replace(/^b:/, '')}` })}`}
                    </span>
                    <span className="row-sub routine-times">{times(r)}</span>
                    {r.lastError && <span className="row-sub routine-error" role="status">{r.lastError}</span>}
                    {r.origin === 'proposal' && <span className="row-sub routine-origin">{t('From your AI’s proposal')}</span>}
                    <span className="routine-actions">
                      {confirm === r.id ? (
                        <span className="team-confirm">
                          <span className="routine-ask">{t('Delete this automation?')}</span>
                          <button type="button" className="pill-btn" disabled={busy === r.id} onClick={() => remove(r)}>{t('Delete')}</button>
                          <button type="button" className="btn-text" onClick={() => setConfirm(null)}>{t('Keep')}</button>
                        </span>
                      ) : (
                        <>
                          <button type="button" className="btn-text" disabled={busy === r.id} onClick={() => runNow(r)}>
                            {busy === r.id ? t('Running…') : t('Run now')}
                          </button>
                          {r.lastCardId && <button type="button" className="btn-text" onClick={() => onOpenCard(r.lastCardId!)}>{r.kind === 'daily_report' || r.kind === 'daily_plan' ? t('Latest draft') : t('Last report')}</button>}
                          <button type="button" className="btn-text" onClick={() => { setConfirm(null); setEditing({ id: r.id, draft: draftFromRoutine(r) }) }}>{t('Edit')}</button>
                          <button type="button" className="btn-text danger" onClick={() => { setEditing(null); setConfirm(r.id) }}>{t('Delete')}</button>
                        </>
                      )}
                    </span>
                  </span>
                  <button
                    className="switch"
                    role="switch"
                    aria-checked={r.enabled}
                    aria-label={t('Run {title} on schedule', { title: r.title })}
                    disabled={busy === r.id}
                    onClick={() => toggle(r)}
                  />
                </div>
              )
            ))}
          </div>
        )}

        <p className="hint insights-hint">{t('automations.cost')}</p>
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}

/// When, what, and for whom — the same three questions whether a routine is
/// being made or changed.
const DraftFields: React.FC<{
  draft: RoutineDraft
  members: Member[]
  withTitle?: boolean
  /// Who it goes to now, for when the member list has not said.
  recipientName?: string
  onChange: (patch: Partial<RoutineDraft>, part: 'schedule' | 'instruction' | 'other') => void
}> = ({ draft, members, withTitle, recipientName, onChange }) => {
  const t = useT()
  const days = useMemo(() => weekdayNames(getLocale()), [])
  const teammates = members.filter((m) => !m.mine)
  // A recipient the list does not have (it has not loaded) still shows as
  // chosen, rather than silently becoming "me" on save.
  const known = draft.recipient === 'me' || teammates.some((m) => `member:${m.ref}` === draft.recipient)
  return (
    <>
      {withTitle && (
        <div className="auto-field">
          <span className="auto-label">{t('Title')}</span>
          <input
            className="ai-key-input"
            value={draft.title || ''}
            maxLength={80}
            onChange={(e) => onChange({ title: e.target.value }, 'other')}
            aria-label={t('Title')}
          />
        </div>
      )}
      <div className="auto-field">
        <span className="auto-label">{t('When')}</span>
        <span className="auto-when">
          <select className="row-select" value={draft.cadence} onChange={(e) => onChange({ cadence: e.target.value as Cadence }, 'schedule')} aria-label={t('How often')}>
            {CADENCES.map((c) => <option key={c} value={c}>{t(CADENCE_WORD[c])}</option>)}
          </select>
          {draft.cadence === 'weekly' && (
            <select className="row-select" value={draft.weekday} onChange={(e) => onChange({ weekday: Number(e.target.value) }, 'schedule')} aria-label={t('Day of the week')}>
              {/* Monday first, the way a working week is read. */}
              {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{days[d]}</option>)}
            </select>
          )}
          {draft.cadence === 'monthly' && (
            <select className="row-select" value={draft.monthday} onChange={(e) => onChange({ monthday: Number(e.target.value) }, 'schedule')} aria-label={t('Day of the month')}>
              {Array.from({ length: 30 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{t('Day {n}', { n: d })}</option>)}
              <option value={31}>{t('Last day')}</option>
            </select>
          )}
          <input
            type="time"
            className="row-select auto-time"
            value={timeValue(draft.hour, draft.minute)}
            onChange={(e) => { const at = parseTime(e.target.value); if (at) onChange(at, 'schedule') }}
            aria-label={t('Time')}
            required
          />
        </span>
      </div>
      <div className="auto-field">
        <span className="auto-label">{t('What')}</span>
        <textarea
          className="ai-key-input auto-what"
          rows={2}
          maxLength={2000}
          value={draft.instruction}
          onChange={(e) => onChange({ instruction: e.target.value }, 'instruction')}
          aria-label={t('What your AI does')}
        />
      </div>
      <div className="auto-field">
        <span className="auto-label">{t('To')}</span>
        <select className="row-select auto-to" value={draft.recipient} onChange={(e) => onChange({ recipient: e.target.value }, 'other')} aria-label={t('Who receives it')}>
          <option value="me">{t('Me')}</option>
          {teammates.map((m) => <option key={m.ref} value={`member:${m.ref}`}>{m.name}</option>)}
          {!known && <option value={draft.recipient}>{recipientName || '—'}</option>}
        </select>
      </div>
    </>
  )
}

/// A daily report's settings: what time, which days, and the channel it is
/// posted to.
const DailyFields: React.FC<{
  draft: RoutineDraft
  businesses: Business[]
  /// Off where the times are chosen separately, morning and evening.
  withTime?: boolean
  onChange: (patch: Partial<RoutineDraft>) => void
}> = ({ draft, businesses, withTime = true, onChange }) => {
  const t = useT()
  const known = businesses.some((b) => `b:${b.slug}` === draft.channel)
  return (
    <>
      <div className="auto-field">
        <span className="auto-label">{t('When')}</span>
        <span className="auto-when">
          <select className="row-select" value={draft.cadence === 'daily' ? 'daily' : 'weekdays'} onChange={(e) => onChange({ cadence: e.target.value as Cadence })} aria-label={t('How often')}>
            <option value="weekdays">{t(CADENCE_WORD.weekdays)}</option>
            <option value="daily">{t(CADENCE_WORD.daily)}</option>
          </select>
          {withTime && (
            <input
              type="time"
              className="row-select"
              value={timeValue(draft.hour, draft.minute)}
              onChange={(e) => { const time = parseTime(e.target.value); if (time) onChange(time) }}
              aria-label={t('Time')}
            />
          )}
        </span>
      </div>
      <div className="auto-field">
        <span className="auto-label">{t('Post to')}</span>
        {businesses.length || draft.channel ? (
          <select className="row-select" value={draft.channel || ''} onChange={(e) => onChange({ channel: e.target.value })} aria-label={t('Post to')}>
            {!known && draft.channel && <option value={draft.channel}>#{draft.channel.replace(/^b:/, '')}</option>}
            {businesses.map((b) => <option key={b.slug} value={`b:${b.slug}`}>#{b.slug}{b.name && b.name !== b.slug ? ` — ${b.name}` : ''}</option>)}
          </select>
        ) : (
          <span className="auto-hint">{t('Make a channel first: the daily report is posted to one.')}</span>
        )}
      </div>
    </>
  )
}

interface DailySetupDraft {
  cadence: Cadence
  channel: string
  morning: { on: boolean; hour: number; minute: number }
  evening: { on: boolean; hour: number; minute: number }
}

/// Setting up the daily report: the days and the channel, and the two times
/// — the morning plan and the evening report — each on or off, each the
/// person's own hour. A half they already have is not offered again.
const DailySetup: React.FC<{
  draft: DailySetupDraft
  businesses: Business[]
  hasPlan: boolean
  hasReport: boolean
  onChange: (patch: Partial<DailySetupDraft>) => void
}> = ({ draft, businesses, hasPlan, hasReport, onChange }) => {
  const t = useT()
  const part = (key: 'morning' | 'evening', label: string) => {
    const value = draft[key]
    return (
      <div className="auto-field daily-part" data-part={key}>
        <label className="daily-toggle">
          <input type="checkbox" checked={value.on} onChange={(e) => onChange({ [key]: { ...value, on: e.target.checked } })} />
          <span>{label}</span>
        </label>
        <input
          type="time"
          className="row-select"
          value={timeValue(value.hour, value.minute)}
          disabled={!value.on}
          onChange={(e) => { const time = parseTime(e.target.value); if (time) onChange({ [key]: { ...value, ...time } }) }}
          aria-label={label}
        />
      </div>
    )
  }
  return (
    <>
      <DailyFields
        draft={{ ...emptyDraft(), cadence: draft.cadence, channel: draft.channel }}
        businesses={businesses}
        withTime={false}
        onChange={(patch) => onChange({ ...(patch.cadence ? { cadence: patch.cadence } : {}), ...(patch.channel !== undefined ? { channel: patch.channel } : {}) })}
      />
      {!hasPlan && part('morning', t('Morning — today’s plan'))}
      {!hasReport && part('evening', t('Evening — how the day went'))}
    </>
  )
}
