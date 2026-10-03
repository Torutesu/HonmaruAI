import React, { useEffect, useId, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'
import {
  CLEAR_AFTER, EMOJI_MAX, STATUS_PRESETS, TEXT_MAX,
  applyPreset, clearedDraft, dayOf, draftFromMine, liveDraft, popoverKey, saveProblem, statusPayload, statusProblem, whenLabel,
  type ClearAfter, type MyStatus, type StatusDraft,
} from '../utils/status'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import './Dialog.css'
import './StatusPopover.css'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  /// Your name and photo, for the top of it.
  me: { name: string; url: string | null }
  /// What opened it: the avatar in the top bar (a phone), the one at the
  /// foot of the rail (a laptop), or the You tab along the bottom of the
  /// list on a phone. It opens beside whichever it was.
  from: 'top' | 'rail' | 'tabs'
  /// The button that opened it: a click on it is its toggle, not a click
  /// outside, and focus goes back to it when it closes.
  anchor: React.RefObject<HTMLElement>
  onClose: () => void
  /// The You screen, which the avatar used to open straight away.
  onProfile: () => void
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
// A mouse or a trackpad: typing is the next thing. On a touch screen the
// keyboard would cover the presets, so focus stays on the popover itself.
const typing = () => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches

/// Your status, one click from your avatar, the way a chat client has it:
/// what it says now, the usual ones a click each, your own emoji and words
/// with when they clear, and being away with who decides meanwhile. A
/// dialog that is not modal: Escape, a click elsewhere or the ✕ closes it.
export const StatusPopover: React.FC<Props> = ({ httpBase, orgId, sessionToken, me, from, anchor, onClose, onProfile }) => {
  const t = useT()
  const locale = getLocale()
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const words = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [tries, setTries] = useState(0)
  // As the server has it, and the people who could decide in your place.
  const [mine, setMine] = useState<MyStatus | null>(null)
  const [myRef, setMyRef] = useState<string | null>(null)
  const [people, setPeople] = useState<Array<{ ref: string; name: string }>>([])
  const [draft, setDraft] = useState<StatusDraft>(() => draftFromMine(null))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const edit = (patch: Partial<StatusDraft>) => { setDraft((d) => ({ ...d, ...patch })); setProblem(null) }

  // Closed by a key or a button, focus goes back to the avatar; closed by a
  // click somewhere else, it stays where that click put it.
  const close = (refocus = true) => {
    onClose()
    if (refocus) anchor.current?.focus()
  }
  const closeRef = useRef(close)
  closeRef.current = close

  // What is set now comes from the list's own read of the team, which is
  // the one that carries who decides for you while you are away.
  useEffect(() => {
    let ignore = false
    setPhase('loading')
    fetch(`${httpBase}/channels?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (ignore) return
        if (!d) { setPhase('failed'); return }
        const members: Array<{ ref: string; name: string; mine?: boolean; guest?: boolean }> = Array.isArray(d.members) ? d.members : []
        setMine(d.mine || null)
        setMyRef(members.find((m) => m.mine)?.ref || null)
        // Only a member can decide for you while you are away: a guest sees only
        // their own channels, and the decisions could be about any of them.
        setPeople(members.filter((m) => !m.mine && !m.guest).map((m) => ({ ref: m.ref, name: m.name })))
        setDraft(draftFromMine(d.mine))
        setPhase('ready')
      })
      .catch(() => { if (!ignore) setPhase('failed') })
    return () => { ignore = true }
  }, [httpBase, orgId, sessionToken, tries])

  // Into it when it opens, onto the words once they are there to edit.
  useEffect(() => {
    if (phase === 'ready' && typing()) words.current?.focus()
    else if (!box.current?.contains(document.activeElement)) box.current?.focus()
  }, [phase])
  // A save that answers after it was closed another way still tells the
  // lists, but does not close or move focus again.
  const open = useRef(true)
  useEffect(() => {
    open.current = true
    return () => { open.current = false }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const at = e.target instanceof Node ? e.target : null
      const does = popoverKey(e, {
        inside: Boolean(at && (box.current?.contains(at) || anchor.current?.contains(at))),
        modal: Boolean(document.querySelector('[aria-modal="true"]')),
      })
      if (does === 'close') {
        // Before the list's own Escape, which would close its pane as well.
        e.stopPropagation()
        closeRef.current()
      } else if (does === 'make-way') {
        // The palette or the shortcuts open on top, from the same key.
        closeRef.current()
      }
    }
    const onDown = (e: MouseEvent) => {
      const at = e.target as Node
      if (box.current?.contains(at) || anchor.current?.contains(at)) return
      closeRef.current(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown, true) }
  }, [anchor])

  const send = async (next: StatusDraft) => {
    if (busy) return
    const now = new Date()
    const wrong = statusProblem(next, now, myRef)
    if (wrong) { setProblem(t(wrong, { n: TEXT_MAX })); return }
    setBusy(true); setProblem(null)
    const res = await fetch(`${httpBase}/channels/status`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify(statusPayload(orgId, next, now)),
    }).catch(() => null)
    const said = res && !res.ok ? await res.json().catch(() => null) : null
    // Every list of the team reads it again, as when somebody joins: the
    // sidebar, a DM's header, an open profile, the names @ offers.
    if (res?.ok) window.dispatchEvent(new Event('honmaru:members-changed'))
    if (!open.current) return
    setBusy(false)
    const refused = saveProblem(res, said)
    if (refused) { setProblem(t(refused)); return }
    close()
  }

  const now = new Date()
  // The last day the Worker takes: within a year of now.
  const lastDay = new Date(now.getTime() + 365 * 86400000)
  const status = mine?.status
  const delegate = mine?.delegateRef ? people.find((p) => p.ref === mine.delegateRef) : null
  // The time a status was already set to, while it is still to come: once
  // it has passed it is no longer offered, and saving clears tonight.
  const clearing = liveDraft(draft, now)

  return (
    <div
      ref={box}
      className={`status-pop from-${from}`}
      role="dialog"
      aria-label={t('Status')}
      tabIndex={-1}
      data-status-popover="1"
      // Letters typed here are for its fields, not the app's shortcuts
      // (N opens Tell your AI); ⌘K and the like still reach it.
      onKeyDown={(e) => { if (!e.metaKey && !e.ctrlKey) e.stopPropagation() }}
    >
      <div className="status-pop-head">
        <Avatar name={me.name || '?'} url={me.url} size={40} />
        <div className="status-pop-who">
          <h2>{me.name || t('You')}</h2>
          {phase === 'ready' && (
            <>
              {status && (
                <p className="status-pop-now" data-status-now="1">
                  {status.emoji && <span className="status-pop-now-emoji" aria-hidden="true">{status.emoji}</span>}
                  {status.text && <span>{status.text}</span>}
                  {status.until && <span className="status-pop-dim"> · {t('until {when}', { when: whenLabel(status.until, now, locale) })}</span>}
                </p>
              )}
              {mine?.awayUntil && (
                <p className="status-pop-now" data-status-away="1">
                  {t('Away until {when}', { when: new Date(mine.awayUntil).toLocaleDateString(locale, { month: 'short', day: 'numeric' }) })}
                  {delegate && <span className="status-pop-dim"> · {t('{name} decides meanwhile', { name: delegate.name })}</span>}
                </p>
              )}
              {!status && !mine?.awayUntil && <p className="status-pop-now status-pop-dim">{t('No status set')}</p>}
            </>
          )}
        </div>
        <button type="button" className="dialog-close" onClick={() => close()} aria-label={t('Close')}><Icon name="x" size={16} /></button>
      </div>

      {phase === 'loading' && <p className="status-pop-body dlg-note" role="status">{t('Loading…')}</p>}
      {phase === 'failed' && (
        <div className="status-pop-body status-pop-failed">
          <p className="dlg-error" role="alert">{t('That did not load.')}</p>
          <button type="button" className="dlg-btn" onClick={() => setTries((n) => n + 1)}>{t('Try again')}</button>
        </div>
      )}
      {phase === 'ready' && (
        <form className="status-pop-body" onSubmit={(e) => { e.preventDefault(); void send(draft) }}>
          <div>
            <label className="dlg-label" htmlFor={`${id}-text`}>{t('Status')}</label>
            <div className="status-pop-line">
              <input
                className="dlg-input status-pop-emoji"
                value={draft.emoji}
                maxLength={EMOJI_MAX}
                onChange={(e) => edit({ emoji: e.target.value })}
                placeholder="🙂"
                aria-label={t('Status emoji')}
                data-status-emoji="1"
              />
              <input
                id={`${id}-text`}
                ref={words}
                className="dlg-input"
                value={draft.text}
                maxLength={TEXT_MAX}
                onChange={(e) => edit({ text: e.target.value })}
                placeholder={t('e.g. In meetings until 3')}
                data-status-text="1"
              />
            </div>
          </div>
          <ul className="status-pop-presets">
            {STATUS_PRESETS.map((p) => (
              <li key={p.text}>
                <button
                  type="button"
                  className="status-pop-preset"
                  onClick={() => { setDraft((d) => applyPreset(d, p, t)); setProblem(null); if (typing()) words.current?.focus() }}
                  data-status-preset={p.text}
                >
                  <span className="status-pop-preset-emoji" aria-hidden="true">{p.emoji}</span>
                  <span className="status-pop-preset-text">{t(p.text)}</span>
                  <span className="status-pop-dim">{t(CLEAR_AFTER.find((c) => c.id === p.clear)?.label || '')}</span>
                </button>
              </li>
            ))}
          </ul>
          <div>
            <label className="dlg-label" htmlFor={`${id}-clear`}>{t('Clear after')}</label>
            <select
              id={`${id}-clear`}
              className="dlg-input"
              value={clearing.clear}
              onChange={(e) => edit({ clear: e.target.value as ClearAfter | 'keep' })}
              data-status-clear-after="1"
            >
              {clearing.keepUntil && <option value="keep">{cap(t('until {when}', { when: whenLabel(clearing.keepUntil, now, locale) }))}</option>}
              {CLEAR_AFTER.map((c) => <option key={c.id} value={c.id}>{t(c.label)}</option>)}
            </select>
          </div>

          <div className="status-pop-away">
            <label className="dlg-check">
              <input
                type="checkbox"
                checked={draft.away}
                onChange={(e) => edit({ away: e.target.checked, awayDate: draft.awayDate || dayOf(now) })}
                data-status-away-toggle="1"
              />
              {t('Away')}
            </label>
            <p className="dlg-hint">{t('While you are away, new decisions for you go to the person you pick, and say they are covering for you.')}</p>
            {draft.away && (
              <div className="status-pop-away-fields">
                <div>
                  <label className="dlg-label" htmlFor={`${id}-until`}>{t('Away until')}</label>
                  <input
                    id={`${id}-until`}
                    type="date"
                    className="dlg-input"
                    value={draft.awayDate}
                    min={dayOf(now)}
                    max={dayOf(lastDay)}
                    onChange={(e) => edit({ awayDate: e.target.value })}
                    data-status-away-until="1"
                  />
                </div>
                {people.length > 0 && (
                  <div>
                    <label className="dlg-label" htmlFor={`${id}-who`}>{t('Who decides meanwhile')}</label>
                    <select id={`${id}-who`} className="dlg-input" value={draft.delegateRef} onChange={(e) => edit({ delegateRef: e.target.value })} data-status-delegate="1">
                      <option value="">{t('Nobody — they wait for me')}</option>
                      {people.map((p) => <option key={p.ref} value={p.ref}>{p.name}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>

          {problem && <p className="dlg-error" role="alert">{problem}</p>}
          <div className="status-pop-actions">
            {status && (
              <button
                type="button"
                className="dlg-btn"
                disabled={busy}
                // Only the status goes: being away stays as the server has it.
                onClick={() => void send(clearedDraft(mine))}
                data-status-clear="1"
              >{t('Clear status')}</button>
            )}
            <button type="submit" className="dlg-btn primary" disabled={busy} data-status-save="1">{busy ? t('Saving…') : t('Save status')}</button>
          </div>
        </form>
      )}

      {phase === 'ready' && <ProxySettings httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} />}

      <div className="status-pop-foot">
        <button type="button" className="status-pop-profile" onClick={onProfile} data-view-profile="1">
          <Icon name="you" size={16} />
          {t('View profile')}
        </button>
      </div>
    </div>
  )
}

interface Proxy { enabled: boolean; agentId: string | null; useTeammate: boolean }

/// Your agent answering for you: when somebody mentions you and asks for
/// something, it does it and answers in the thread, as your agent. Saved as
/// it is changed, apart from the status above.
const ProxySettings: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const id = useId()
  const [proxy, setProxy] = useState<Proxy | null>(null)
  const [agents, setAgents] = useState<Array<{ id: string; name: string; handle: string }>>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const headers = { 'x-session-token': sessionToken }
  const loadAgents = async () => {
    const res = await fetch(`${httpBase}/channels/agents?orgId=${encodeURIComponent(orgId)}`, { headers }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    // Yours only: a teammate's agent never answers for you.
    if (Array.isArray(data?.agents)) setAgents(data.agents.filter((a: { scope?: string; mine?: boolean; provider?: string | null }) => a.scope === 'personal' && a.mine && !a.provider))
  }
  useEffect(() => {
    let ignore = false
    void fetch(`${httpBase}/channels/proxy?orgId=${encodeURIComponent(orgId)}`, { headers }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (!ignore && d?.proxy) setProxy(d.proxy) }).catch(() => {})
    void loadAgents()
    return () => { ignore = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [httpBase, orgId, sessionToken])
  // Never disabled while it saves: a control that is disabled under the
  // keyboard drops its focus out of the popover, and Escape with it.
  const save = async (patch: Partial<Proxy>) => {
    if (busy) return
    const before = proxy
    // Shown at once; put back if the server says no.
    setProxy((p) => (p ? { ...p, ...patch } : p))
    setBusy(true)
    setProblem(null)
    const res = await fetch(`${httpBase}/channels/proxy`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId, ...patch }),
    }).catch(() => null)
    const data = res ? await res.json().catch(() => ({})) : {}
    setBusy(false)
    if (!res?.ok || !data.proxy) { setProxy(before); setProblem((typeof data.message === 'string' && data.message) || t('That did not save.')); return }
    setProxy(data.proxy)
    // Turned on, an agent may have been made for you.
    if (patch.enabled) void loadAgents()
  }
  if (!proxy) return null
  return (
    <div className="status-pop-body status-pop-proxy" data-proxy-settings="1">
      <label className="dlg-check">
        <input type="checkbox" checked={proxy.enabled} onChange={(e) => void save({ enabled: e.target.checked })} data-proxy-toggle="1" />
        {t('My agent answers when I am mentioned')}
      </label>
      <p className="dlg-hint">{t('When someone mentions you and asks for something, your agent does it and answers in the thread as your agent. Anything it would post outside the chat, such as a comment on GitHub, waits for your approval.')}</p>
      {proxy.enabled && (
        <div className="status-pop-proxy-fields">
          {agents.length > 0 && (
            <div>
              <label className="dlg-label" htmlFor={`${id}-agent`}>{t('Which agent')}</label>
              <select id={`${id}-agent`} className="dlg-input" value={proxy.agentId || ''} onChange={(e) => void save({ agentId: e.target.value })} data-proxy-agent="1">
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name} (@{a.handle})</option>)}
              </select>
            </div>
          )}
          <label className="dlg-check">
            <input type="checkbox" checked={proxy.useTeammate} onChange={(e) => void save({ useTeammate: e.target.checked })} data-proxy-teammate="1" />
            {t('Code work goes to the AI teammate (Claude)')}
          </label>
        </div>
      )}
      {problem && <p className="dlg-error" role="alert">{problem}</p>}
    </div>
  )
}
