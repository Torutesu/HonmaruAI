import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { JAM_MODES, audioDevices, canPickSpeaker, recordingMime } from '../utils/jam'
import type { JamCall, JamMode, JamState } from '../utils/jam'
import { Icon } from './Icon'
import { Avatar } from './Avatar'

// What a channel's header opens, left to right: its journal (the context
// someone new or back from a week away reads first), its details (members,
// what was shared, what runs into it), and a Jam — talking out loud.

interface Api { httpBase: string; orgId: string }
type Headers = Record<string, string>

export interface JournalCite { id: string; parentId: string | null; at: string }
interface JournalItem { text: string; messageIds: string[]; cites: JournalCite[]; links: Array<{ url: string; host: string }> }
interface JournalDay { day: string; count: number; firstAt: string | null; byModel: boolean; items: JournalItem[] }

export type DetailsTab = 'members' | 'attachments' | 'automations'
export type NotifyLevel = 'all' | 'mentions' | 'mute'

interface Details {
  channel: { key: string; view: string; kind: 'channel' | 'dm' | 'group'; private?: boolean; name: string; slug: string | null; description: string | null; createdAt: string | null; createdBy: string | null }
  members: {
    people: Array<{ ref: string; name: string; handle: string | null; title: string | null; status: { emoji?: string; text?: string } | null; awayUntil: string | null; you: boolean; avatarUrl?: string | null }>
    agents: Array<{ name: string; kind: 'ai' | 'agent'; owner: string | null; lastSeenAt?: string | null }>
  }
  attachments: Array<{ url: string; host: string; messageId: string; authorName: string | null; at: string }>
  automations: Array<{ id: string; kind: string; title: string; schedule: string; enabled: boolean; ownerName: string | null; mine: boolean; nextRunAt: string | null }>
  counts: { members: number; automations: number; attachments: number }
}

const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }

function dayLabel(day: string, locale: string, t: (k: string) => string): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const diff = Math.round((start.getTime() - date.getTime()) / 86400000)
  if (diff === 0) return t('Today')
  if (diff === 1) return t('Yesterday')
  return date.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', ...(y !== today.getFullYear() ? { year: 'numeric' } : {}) })
}

/// A channel's description, read and — in a business channel — written.
function Description({ api, headers, view, value, editable, onSaved }: { api: Api; headers: Headers; view: string; value: string | null; editable: boolean; onSaved: (v: string | null) => void }) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value || '')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => { if (!editing) setText(value || '') }, [value, editing])
  const save = async () => {
    setBusy(true); setProblem(null)
    const res = await fetch(`${api.httpBase}/channels/description`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: view, description: text }),
    }).catch(() => null)
    setBusy(false)
    const data = res ? await res.json().catch(() => null) : null
    if (!res?.ok) { setProblem(data?.message || t('That did not save.')); return }
    onSaved(data?.description ?? null)
    setEditing(false)
  }
  if (editing) {
    return (
      <form className="slk-describe" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <textarea
          className="cl-input" value={text} rows={3} maxLength={500} autoFocus disabled={busy}
          placeholder={t('What is this channel for?')} aria-label={t('Channel description')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }}
        />
        {problem && <p className="cl-problem" role="alert">{problem}</p>}
        <div className="slk-describe-bar">
          <button type="button" className="cl-nudge" onClick={() => setEditing(false)}>{t('Cancel')}</button>
          <button type="submit" className="slk-send" disabled={busy}>{t('Save')}</button>
        </div>
      </form>
    )
  }
  return (
    <div className="slk-description">
      {value ? <p>{value}</p> : null}
      {editable && (
        <button type="button" className="slk-link-button" onClick={() => setEditing(true)}>
          {value ? t('Edit description') : <><span aria-hidden="true">＋</span> {t('Add description')}</>}
        </button>
      )}
    </div>
  )
}

/// "Context for #channel": a few lines a day, newest first, each citing the
/// messages it came from, back to the start of the journal.
export function ChannelJournal({ api, headers, view, title, locale, onCite, onClose }: {
  api: Api; headers: Headers; view: string; title: string; locale: string
  onCite: (cite: JournalCite) => void
  onClose: () => void
}) {
  const t = useT()
  const [days, setDays] = useState<JournalDay[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [description, setDescription] = useState<string | null>(null)
  const [describable, setDescribable] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const tz = useMemo(zone, [])

  const load = useCallback(async (before: string | null) => {
    setLoading(true); setProblem(null)
    const q = new URLSearchParams({ orgId: api.orgId, channel: view, tz, ...(before ? { before } : {}) })
    const res = await fetch(`${api.httpBase}/channels/journal?${q}`, { headers }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    setLoading(false)
    if (!data) { setProblem(t('The journal did not load. Try again.')); return }
    setDays((prev) => (before && prev ? [...prev, ...data.days] : data.days))
    setNext(data.next); setMore(Boolean(data.more))
    if (!before) { setDescription(data.description); setDescribable(Boolean(data.describable)) }
  }, [api.httpBase, api.orgId, headers, tz, view, t])
  useEffect(() => { setDays(null); void load(null) }, [load])

  // A new description from anyone in the channel.
  useEffect(() => {
    const on = (e: Event) => {
      const { name, value } = (e as CustomEvent<{ name: string; value: any }>).detail || {}
      if (name === 'channel_described' && value?.channel === view) setDescription(value.description ?? null)
    }
    window.addEventListener('honmaru:jam', on)
    return () => window.removeEventListener('honmaru:jam', on)
  }, [view])

  return (
    <aside className="slk-pane slk-journal" aria-label={t('Context')}>
      <header className="slk-pane-head">
        <button className="slk-back pane" onClick={onClose} aria-label={t('Back')}><span aria-hidden="true">‹</span></button>
        <h2>{t('Context for {name}', { name: title })}</h2>
        <button className="slk-pane-close" onClick={onClose} aria-label={t('Close')}><Icon name="x" size={16} /></button>
      </header>
      <div className="slk-pane-body slk-journal-body">
        <Description api={api} headers={headers} view={view} value={description} editable={describable} onSaved={setDescription} />
        {problem && <p className="cl-problem" role="alert">{problem}</p>}
        {days === null && !problem && <p className="slk-empty" role="status">{t('Reading the channel…')}</p>}
        {days && days.length === 0 && <p className="slk-empty">{t('Nothing has been said here yet.')}</p>}
        {(days || []).map((d) => (
          <section key={d.day} className="slk-jday" data-day={d.day}>
            <h3>
              <span>{dayLabel(d.day, locale, t)}</span>
              <span className="slk-jcount">{d.count === 1 ? t('1 message') : t('{n} messages', { n: d.count })}</span>
            </h3>
            <ul>
              {d.items.map((item, i) => (
                <li key={i}>
                  <span className="slk-jtext">{item.text}</span>
                  {item.cites.map((c, n) => (
                    <button
                      key={c.id} type="button" className="slk-cite"
                      title={t('Go to the message')} aria-label={t('Go to message {n}', { n: n + 1 })}
                      onClick={() => onCite(c)}
                    >{n + 1}</button>
                  ))}
                  {item.links.map((l) => (
                    <a key={l.url} className="slk-jlink" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>
                      <Icon name="external" size={11} /> {l.host}
                    </a>
                  ))}
                </li>
              ))}
            </ul>
            {!d.byModel && d.items.length > 0 && <p className="slk-jnote">{t('The busiest conversations of the day. With an AI key, your AI writes this up.')}</p>}
          </section>
        ))}
        {more && next && (
          <button type="button" className="cl-nudge slk-jmore" disabled={loading} onClick={() => void load(next)}>
            {loading ? t('Loading…') : t('Earlier days')}
          </button>
        )}
        {days && days.length > 0 && !more && <div className="slk-jstart" role="note">{t('Start of the journal')}</div>}
      </div>
    </aside>
  )
}

/// The channel's details: who is in it, what was shared, what runs into it.
export function ChannelDetails({
  api, headers, view, tab, onTab, level, onLevel, onSettings, onInvite, onProfile, onJump, onCounts, onClose, locale,
}: {
  api: Api; headers: Headers; view: string; tab: DetailsTab; locale: string
  onTab: (tab: DetailsTab) => void
  level: NotifyLevel
  onLevel: (level: NotifyLevel) => void
  /// The channel's own controls — rename, delete — or null in a direct one.
  onSettings: (() => void) | null
  onInvite: () => void
  onProfile: (ref: string) => void
  onJump: (messageId: string) => void
  /// What the header counts, as the panel last read it.
  onCounts?: (counts: Details['counts']) => void
  onClose: () => void
}) {
  const t = useT()
  const [d, setD] = useState<Details | null>(null)
  const countsRef = useRef(onCounts)
  countsRef.current = onCounts
  const [problem, setProblem] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [ask, setAsk] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const q = new URLSearchParams({ orgId: api.orgId, channel: view })
    const res = await fetch(`${api.httpBase}/channels/details?${q}`, { headers }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    if (!data) { setProblem(t('The details did not load. Try again.')); return }
    setProblem(null)
    setD(data)
    countsRef.current?.(data.counts)
  }, [api.httpBase, api.orgId, headers, view, t])
  useEffect(() => { setD(null); void load() }, [load])

  const toggle = async (id: string, enabled: boolean) => {
    setD((prev) => prev && { ...prev, automations: prev.automations.map((a) => (a.id === id ? { ...a, enabled } : a)) })
    const res = await fetch(`${api.httpBase}/routines/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, enabled }),
    }).catch(() => null)
    if (!res?.ok) { setProblem(t('That did not save.')); void load() }
  }

  /// "Every Monday at 9, summarise last week here" — read for its schedule
  /// the way the Automations screen reads it, and posted into this channel.
  const create = async () => {
    const text = ask.trim()
    if (!text || busy) return
    setBusy(true); setProblem(null)
    const post = (path: string, body: unknown) => fetch(`${api.httpBase}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const parsed = await post('/routines/parse', { text, locale }).then((r) => r.json()).then((x) => x.parsed).catch(() => null)
    if (!parsed) { setBusy(false); setProblem(t('Say when, too — for example “every Monday at 9”.')); return }
    const tz = zone()
    const res = await post('/routines', {
      orgId: api.orgId, kind: 'report', instruction: parsed.instruction || text, cadence: parsed.cadence,
      weekday: parsed.weekday, monthday: parsed.monthday, hour: parsed.hour, minute: parsed.minute, timezone: tz, channel: view,
    }).catch(() => null)
    setBusy(false)
    if (!res?.ok) { setProblem(((await res?.json().catch(() => null))?.message) || t('That did not save.')); return }
    setAsk(''); setAdding(false)
    void load()
  }

  const people = (d?.members.people || []).filter((p) => !query.trim() || `${p.name} ${p.handle || ''} ${p.title || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const agents = (d?.members.agents || []).filter((a) => !query.trim() || a.name.toLowerCase().includes(query.trim().toLowerCase()))
  const isChannel = d?.channel.kind === 'channel'
  const tabs: Array<[DetailsTab, string, number]> = [
    ['members', t('Members'), d?.counts.members ?? 0],
    ['attachments', t('Attachments'), d?.counts.attachments ?? 0],
    ...(isChannel ? [['automations', t('Automations'), d?.counts.automations ?? 0] as [DetailsTab, string, number]] : []),
  ]

  return (
    <aside className="slk-pane slk-details" aria-label={t('Channel details')}>
      <header className="slk-pane-head slk-details-head">
        <button className="slk-back pane" onClick={onClose} aria-label={t('Back')}><span aria-hidden="true">‹</span></button>
        <div className="slk-details-title">
          <h2>{d ? (isChannel && !d.channel.private ? `#${d.channel.name}` : d.channel.name) : '…'}</h2>
          {d?.channel.createdAt && (
            <p>{d.channel.createdBy
              ? t('Created on {date} by {name}', { date: new Date(d.channel.createdAt).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' }), name: d.channel.createdBy })
              : t('Created on {date}', { date: new Date(d.channel.createdAt).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' }) })}</p>
          )}
        </div>
        <button className="slk-pane-close" onClick={onClose} aria-label={t('Close')}><Icon name="x" size={16} /></button>
      </header>
      <div className="slk-details-bar">
        <label className="slk-select">
          <span className="sr-only">{t('Default notifications')}</span>
          <Icon name="bell" size={14} />
          <select value={level} onChange={(e) => onLevel(e.target.value as NotifyLevel)} aria-label={t('Default notifications')}>
            <option value="all">{t('Everything')}</option>
            <option value="mentions">{t('Mentions only')}</option>
            <option value="mute">{t('Nothing (mute)')}</option>
          </select>
        </label>
        {onSettings && <button type="button" className="cl-nudge" onClick={onSettings}>{t('Settings')}</button>}
      </div>
      <nav className="slk-tabs slk-details-tabs" role="tablist" aria-label={t('Channel details')}>
        {tabs.map(([key, label, n]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => onTab(key)} data-tab={key}>
            {label}<span className="slk-tab-count">{n}</span>
          </button>
        ))}
      </nav>
      <div className="slk-pane-body slk-details-body">
        {problem && <p className="cl-problem" role="alert">{problem}</p>}
        {!d && !problem && <p className="slk-empty" role="status">{t('Loading…')}</p>}
        {d && tab === 'members' && (
          <>
            <input className="cl-input slk-details-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search members')} aria-label={t('Search members')} />
            <h3 className="slk-details-group">{t('People ({n})', { n: people.length })}</h3>
            <ul className="slk-details-list">
              {people.map((p) => (
                <li key={p.ref}>
                  <button type="button" className="slk-member-row" onClick={() => onProfile(p.ref)}>
                    <span className="cl-lead cl-avatar has-face sz-row" aria-hidden="true"><Avatar name={p.name} url={p.avatarUrl} size={24} /></span>
                    <span className="slk-member-main">
                      <span className="slk-member-name">{p.name}{p.you && <span className="slk-member-you"> {t('(you)')}</span>}{p.status?.emoji && <span> {p.status.emoji}</span>}</span>
                      {p.title && <span className="slk-member-title">{p.title}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <h3 className="slk-details-group">{t('Agents ({n})', { n: agents.length })}</h3>
            <ul className="slk-details-list">
              {agents.map((a, i) => (
                <li key={`${a.name}-${i}`}>
                  <div className="slk-member-row static">
                    {a.kind === 'ai'
                      ? <span className="cl-lead cl-app sz-row" aria-hidden="true"><img className="cl-own-mark" src="/icon.svg" alt="" width={18} height={18} /></span>
                      : <span className="cl-lead cl-app sz-row" aria-hidden="true"><Icon name="settings" size={13} /></span>}
                    <span className="slk-member-main">
                      <span className="slk-member-name">{a.name}</span>
                      <span className="slk-member-title">{a.kind === 'ai' ? t('Turns what is said here into decisions') : a.owner ? t('Connected by {name}', { name: a.owner }) : t('Connected tool')}</span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            {isChannel && <button type="button" className="slk-send slk-details-add" onClick={onInvite}>{t('Add members')}</button>}
          </>
        )}
        {d && tab === 'attachments' && (
          d.attachments.length === 0
            ? <p className="slk-empty">{t('Links shared here are collected here.')}</p>
            : (
              <ul className="slk-details-list">
                {d.attachments.map((a) => (
                  <li key={`${a.messageId}-${a.url}`} className="slk-attachment">
                    <span className="slk-attachment-mark" aria-hidden="true">{a.host.charAt(0).toUpperCase()}</span>
                    <span className="slk-member-main">
                      <a className="slk-member-name" href={a.url} target="_blank" rel="noopener noreferrer" title={a.url}>{a.url.replace(/^https?:\/\/(www\.)?/, '')}</a>
                      <span className="slk-member-title">
                        {a.authorName || t('Your AI')} · {new Date(a.at).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}
                        {' · '}<button type="button" className="slk-link-button" onClick={() => onJump(a.messageId)}>{t('Go to the message')}</button>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )
        )}
        {d && tab === 'automations' && (
          <>
            {d.automations.length === 0 && !adding && <p className="slk-empty">{t('Nothing runs here yet. An automation has your AI post into this channel on a schedule.')}</p>}
            <ul className="slk-details-list">
              {d.automations.map((a) => (
                <li key={a.id} className="slk-automation">
                  <span className="cl-lead cl-app sz-row" aria-hidden="true"><Icon name="zap" size={13} /></span>
                  <span className="slk-member-main">
                    <span className="slk-member-name">{a.title}</span>
                    <span className="slk-member-title">{a.schedule}{a.ownerName && !a.mine ? ` · ${t('by {name}', { name: a.ownerName })}` : ''}</span>
                  </span>
                  <label className="slk-switch" title={a.mine ? undefined : t('Only {name} can change this.', { name: a.ownerName || t('its owner') })}>
                    <input type="checkbox" role="switch" checked={a.enabled} disabled={!a.mine} onChange={(e) => void toggle(a.id, e.target.checked)} aria-label={a.enabled ? t('Pause {title}', { title: a.title }) : t('Resume {title}', { title: a.title })} />
                    <span aria-hidden="true" />
                  </label>
                </li>
              ))}
            </ul>
            {adding ? (
              <form className="slk-describe" onSubmit={(e) => { e.preventDefault(); void create() }}>
                <textarea
                  className="cl-input" rows={3} autoFocus value={ask} disabled={busy} maxLength={2000}
                  placeholder={t('For example: every Monday at 9, summarise last week’s decisions here')}
                  aria-label={t('What should your AI post here, and when?')}
                  onChange={(e) => setAsk(e.target.value)}
                />
                <div className="slk-describe-bar">
                  <button type="button" className="cl-nudge" onClick={() => setAdding(false)}>{t('Cancel')}</button>
                  <button type="submit" className="slk-send" disabled={busy || !ask.trim()}>{busy ? t('Saving…') : t('Create')}</button>
                </div>
              </form>
            ) : (
              <button type="button" className="slk-send slk-details-add" onClick={() => setAdding(true)}>{t('New automation')}</button>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

const DEVICE_KEY = 'jam.devices'
function savedDevices(): { mic?: string; speaker?: string; mode?: JamMode } {
  try { return JSON.parse(localStorage.getItem(DEVICE_KEY) || '{}') || {} } catch { return {} }
}
function saveDevices(v: { mic?: string; speaker?: string; mode?: JamMode }) {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(v)) } catch { /* this browser only */ }
}

export function modeLabel(mode: JamMode, t: (k: string) => string): string {
  return mode === 'full' ? t('Full recording') : mode === 'notes' ? t('Notes only') : t('Don’t record')
}

/// The Jam button, and its menu: microphone, speaker, whether it is
/// recorded, and Start (or Join, when one is going).
export function JamButton({ state, inThis, busy, onStart, onLeave }: {
  state: JamState | undefined
  /// This browser is in this channel's Jam.
  inThis: boolean
  busy: boolean
  onStart: (opts: { micId?: string; speakerId?: string; mode: JamMode }) => void
  onLeave: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const saved = useMemo(savedDevices, [])
  const [mic, setMic] = useState(saved.mic || '')
  const [speaker, setSpeaker] = useState(saved.speaker || '')
  const [mode, setMode] = useState<JamMode>(saved.mode || (recordingMime() ? 'notes' : 'off'))
  const box = useRef<HTMLDivElement>(null)
  const active = Boolean(state?.active)
  const count = state?.participants.length || 0

  useEffect(() => {
    if (!open) return
    void audioDevices().then(({ inputs, outputs }) => { setInputs(inputs); setOutputs(outputs) })
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  const start = () => {
    saveDevices({ mic: mic || undefined, speaker: speaker || undefined, mode })
    setOpen(false)
    onStart({ micId: mic || undefined, speakerId: speaker || undefined, mode })
  }
  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`

  if (inThis) {
    return (
      <button type="button" className="slk-jam-button on" onClick={onLeave} disabled={busy}>
        <Icon name="headphones" size={14} /> {t('Leave Jam')}
      </button>
    )
  }
  return (
    <div className="slk-jam" ref={box}>
      <button type="button" className={`slk-jam-button${active ? ' live' : ''}`} onClick={() => (active ? onStart({ micId: mic || undefined, speakerId: speaker || undefined, mode }) : start())} disabled={busy}>
        <Icon name="headphones" size={14} /> {active ? t('Join Jam') : t('Jam')}
        {active && <span className="slk-jam-count">{count}</span>}
      </button>
      <button type="button" className="slk-jam-more" onClick={() => setOpen((v) => !v)} aria-label={t('Jam options')} aria-expanded={open} disabled={busy}>
        <Icon name="chevron-down" size={13} />
      </button>
      {open && (
        <div className="slk-jam-menu" role="dialog" aria-label={t('Jam options')}>
          <label>
            <span>{t('Microphone')}</span>
            <select value={mic} onChange={(e) => setMic(e.target.value)}>
              <option value="">{t('Default')}</option>
              {inputs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i, t('Microphone'))}</option>)}
            </select>
          </label>
          {canPickSpeaker() && (
            <label>
              <span>{t('Speaker')}</span>
              <select value={speaker} onChange={(e) => setSpeaker(e.target.value)}>
                <option value="">{t('Default')}</option>
                {outputs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i, t('Speaker'))}</option>)}
              </select>
            </label>
          )}
          <label>
            <span>{t('Recording')}</span>
            {active
              ? <span className="slk-jam-fixed">{modeLabel(state!.mode, t)}</span>
              : (
                <select value={mode} onChange={(e) => setMode(e.target.value as JamMode)}>
                  {JAM_MODES.filter((m) => m === 'off' || recordingMime()).map((m) => <option key={m} value={m}>{modeLabel(m, t)}</option>)}
                </select>
              )}
          </label>
          <p className="slk-jam-hint">
            {(active ? state!.mode : mode) === 'full'
              ? t('Everyone is recorded. Your AI posts notes here afterwards, with the recording.')
              : (active ? state!.mode : mode) === 'notes'
                ? t('Your AI posts notes here afterwards. The audio is not kept.')
                : t('Nothing is recorded.')}
          </p>
          <button type="button" className="slk-send slk-jam-start" onClick={start}>{active ? t('Join Jam') : t('Start Jam')}</button>
        </div>
      )}
    </div>
  )
}

function clock(since: string | null, now: number): string {
  if (!since) return '0:00'
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/// The Jam this browser is in: who is talking, how long, recorded or not;
/// mute and leave.
export function JamBar({ call, where, onLeave, onMute, onShow }: { call: JamCall; where: string; onLeave: () => void; onMute: (muted: boolean) => void; onShow?: () => void }) {
  const t = useT()
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  const startedAt = call.startedAt
  return (
    <div className="slk-jambar" role="region" aria-label={t('Jam')}>
      <span className="slk-jambar-live" aria-hidden="true" />
      <span className="slk-jambar-where">{t('Jam in {where}', { where })}</span>
      <span className="slk-jambar-clock">{clock(startedAt, now)}</span>
      {call.recording && <span className="slk-jambar-rec">● {t('Recording')}</span>}
      {!call.inCall && <span className="slk-jambar-wait">{t('Connecting…')}</span>}
      <ul className="slk-jambar-people">
        {call.participants.map((p) => (
          <li key={p.peerId} title={p.name} className={p.muted ? 'muted' : ''}>
            <span className="cl-lead cl-avatar has-face sz-row" aria-hidden="true"><Avatar name={p.name} url={p.avatarUrl} size={20} /></span>
            <span className="sr-only">{p.name}{p.muted ? ` (${t('muted')})` : ''}</span>
          </li>
        ))}
      </ul>
      {onShow && <button type="button" className="cl-nudge slk-jambar-show" onClick={onShow}>{t('Show')}</button>}
      <button type="button" className={`cl-nudge${call.muted ? ' on' : ''}`} onClick={() => onMute(!call.muted)} aria-pressed={call.muted}>
        {call.muted ? t('Unmute') : t('Mute')}
      </button>
      <button type="button" className="cl-nudge cl-danger" onClick={onLeave}>{t('Leave')}</button>
    </div>
  )
}
