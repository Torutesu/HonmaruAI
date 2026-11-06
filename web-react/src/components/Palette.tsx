import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Business, DecisionCard } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName } from '../utils/names'
import { useT } from '../utils/i18n'
import { useMembers } from '../utils/mentions'
import { emptyQueryPlaces, placesFallback, rankPlaces } from '../utils/places'
import type { Place } from '../utils/places'
import type { Screen } from '../utils/route'
import { Icon } from './Icon'
import { composing, enterKey } from '../utils/keys'

export type PaletteAction =
  | { kind: 'card'; cardId: string }
  | { kind: 'screen'; screen: Screen }
  | { kind: 'feed' }
  | { kind: 'list' }
  | { kind: 'compose' }
  | { kind: 'message'; view: string; id: string; parentId?: string | null }
  | { kind: 'appRecord'; appId: string; tableId: string; rowId: string }
  | { kind: 'file'; fileId: string; scope: string }
  /// A conversation, opened in the list.
  | { kind: 'view'; view: string }

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  cards: DecisionCard[]
  /// Every conversation the list can open, as it last said. Empty until the
  /// list has been drawn once; the channels and the team stand in till then.
  places?: Place[]
  /// Views opened lately, most recent first.
  recent?: string[]
  /// The conversation open now: with nothing typed it is not offered, so
  /// ⌘K then Enter goes back to the one before.
  current?: string | null
  /// The workspace's channels, for before the list has been drawn.
  businesses?: Business[]
  onPick: (action: PaletteAction) => void
  onClose: () => void
}

interface Item { key: string; group: 'places' | 'actions' | 'cards' | 'past' | 'messages' | 'files' | 'records'; label: string; meta?: string; place?: Place; action: PaletteAction }

const NONE: never[] = []

/// Whether the pointer really moved, rather than the list scrolling under a
/// pointer left resting on it — which a browser also reports as a move, at
/// the same place on the screen. The first move seen is judged by how far
/// it says it went.
export function pointerMoved(
  last: { x: number; y: number } | null,
  e: { screenX: number; screenY: number; movementX?: number; movementY?: number },
): boolean {
  if (last) return last.x !== e.screenX || last.y !== e.screenY
  return Boolean(e.movementX || e.movementY)
}

const ACTION_WORD: Record<string, string> = {
  approve: 'Approved', decline: 'Declined', revise: 'Revision asked',
  choose: 'Chose', reply: 'Replied', acknowledge: 'Acknowledged',
  delegate: 'Delegated', later: 'Deferred', pending: 'Waiting',
}

/// ⌘K. One box that goes anywhere and finds anything: a conversation by a
/// few letters of its name, a screen, an action, a card the browser already
/// has, and — a moment later — what the team decided before, from the
/// Worker's search. Enter takes the highlighted row; Escape closes.
export const Palette: React.FC<Props> = ({ httpBase, orgId, sessionToken, cards, places = NONE, recent = NONE, current = null, businesses = NONE, onPick, onClose }) => {
  const t = useT()
  const locale = getLocale()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [past, setPast] = useState<Item[]>([])
  const [said, setSaid] = useState<Item[]>([])
  const [resources, setResources] = useState<Item[]>([])
  const [resourceTruncated, setResourceTruncated] = useState(false)
  const [resourcePage, setResourcePage] = useState<{ file: string | null; record: string | null } | null>(null)
  const [nextFileCursor, setNextFileCursor] = useState<string | null>(null)
  const [nextRecordCursor, setNextRecordCursor] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { input.current?.focus() }, [])

  const q = query.trim().toLowerCase()
  // Slack's filters (from:@x in:#y before: after: is:pinned has:thread) go
  // to message search as they are; the rest of the box searches the text.
  const filtered = /(^|\s)(from|in|to|before|after|on|during|is|has):\S/i.test(query) || /(^|\s)(-\S{2,}|"[^"]+")/.test(query)
  // The filters, as chips that write themselves into the box.
  const month = new Date().toISOString().slice(0, 7)
  const FILTERS: Array<{ token: string; label: string }> = [
    { token: 'from:me', label: t('From me') },
    { token: 'has:file', label: t('Has a file') },
    { token: 'has:link', label: t('Has a link') },
    { token: 'has:reaction', label: t('Has reactions') },
    { token: 'is:thread', label: t('In a thread') },
    { token: 'is:saved', label: t('Saved') },
    { token: 'is:dm', label: t('In DMs') },
    { token: `during:${month}`, label: t('This month') },
  ]
  const addFilter = (token: string) => {
    setQuery((cur) => (cur.includes(token) ? cur : `${cur.trim()} ${token} `.trimStart()))
    input.current?.focus()
  }
  const actions: Item[] = useMemo(() => {
    const all: Item[] = [
      { key: 'a:compose', group: 'actions', label: t('Tell your AI'), meta: 'n', action: { kind: 'compose' } },
      { key: 'a:feed', group: 'actions', label: t('Feed'), action: { kind: 'feed' } },
      { key: 'a:list', group: 'actions', label: t('Classic'), action: { kind: 'list' } },
      { key: 'a:history', group: 'actions', label: t('History'), action: { kind: 'screen', screen: 'history' } },
      { key: 'a:tools', group: 'actions', label: t('Tools'), action: { kind: 'screen', screen: 'tools' } },
      { key: 'a:team', group: 'actions', label: t('Your team'), action: { kind: 'screen', screen: 'team' } },
      { key: 'a:insights', group: 'actions', label: t('Insights'), action: { kind: 'screen', screen: 'insights' } },
      { key: 'a:automations', group: 'actions', label: t('Automations'), action: { kind: 'screen', screen: 'automations' } },
      { key: 'a:playbook', group: 'actions', label: t('Playbook'), action: { kind: 'screen', screen: 'playbook' } },
      { key: 'a:agents', group: 'actions', label: t('Agents'), action: { kind: 'screen', screen: 'agents' } },
      { key: 'a:notifications', group: 'actions', label: t('Notifications'), action: { kind: 'screen', screen: 'notifications' } },
      { key: 'a:plans', group: 'actions', label: t('Plans'), action: { kind: 'screen', screen: 'plans' } },
      { key: 'a:you', group: 'actions', label: t('You'), action: { kind: 'screen', screen: 'profile' } },
    ]
    return q ? all.filter((a) => a.label.toLowerCase().includes(q)) : all
  }, [q, t])

  // Conversations, first, as a chat client's switcher has them: the list's
  // own, or — before the list has ever been drawn — the channels and the team.
  const team = useMembers(httpBase, orgId, sessionToken)
  const known = useMemo(() => (places.length ? places : placesFallback(businesses, team)), [places, businesses, team])
  const jumps: Item[] = useMemo(() => {
    if (filtered) return []
    // Where you were before the one you are in: the one you are in is where
    // you are, not where you were, so a lone # does not lead with it either.
    const before = recent.filter((v) => v !== current)
    const found = query.trim()
      ? rankPlaces(known, query, before)
      : emptyQueryPlaces(known.filter((p) => p.view !== current), before)
    return found.map((p) => ({
      key: `v:${p.view}`, group: 'places' as const, label: p.name, place: p,
      meta: p.kind === 'agent' ? t('Agent') : p.kind === 'person' && p.handle ? `@${p.handle}` : undefined,
      action: { kind: 'view' as const, view: p.view },
    }))
  }, [filtered, query, known, recent, current, t])

  const here: Item[] = useMemo(() => {
    if (!q) return []
    return cards
      .filter((c) => {
        const l = c.localized?.[locale]
        return [l?.title || c.title, l?.summary || c.summary, c.requestedBy?.name, c.senderUserID, c.sourceApp]
          .some((s) => (s || '').toLowerCase().includes(q))
      })
      .slice(0, 8)
      .map((c) => ({
        key: `c:${c.id}`, group: 'cards' as const,
        label: c.localized?.[locale]?.title || c.title,
        meta: `${t(ACTION_WORD[c.decision?.action || c.status] || c.status)} · ${displayName(c.requestedBy?.name || c.senderUserID)}`,
        action: { kind: 'card' as const, cardId: c.id },
      }))
  }, [q, cards, locale, t])

  // The Worker's search, a beat after typing stops. Only what the browser
  // does not already show.
  useEffect(() => {
    if (q.length < 2) { setPast([]); return }
    let ignore = false
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`${httpBase}/search?orgId=${encodeURIComponent(orgId)}&q=${encodeURIComponent(q)}`, {
          headers: { 'x-session-token': sessionToken },
        })
        if (!res.ok) return
        const data = await res.json()
        if (ignore) return
        const known = new Set(cards.map((c) => c.id))
        setPast((data.hits || [])
          .filter((h: { id?: string }) => h.id && !known.has(h.id))
          .map((h: { id: string; title: string; status: string; decidedAt: string | null; recipient: string }) => ({
            key: `p:${h.id}`, group: 'past' as const, label: h.title,
            meta: `${t(ACTION_WORD[h.status] || h.status)}${h.decidedAt ? ` · ${h.decidedAt.slice(0, 10)}` : ''} · ${displayName(h.recipient)}`,
            action: { kind: 'card' as const, cardId: h.id },
          })))
      } catch { /* the browser's own matches stand */ }
    }, 250)
    return () => { ignore = true; clearTimeout(id) }
  }, [q, httpBase, orgId, sessionToken, cards, t])

  // What was said in channels and DMs, from the Worker.
  useEffect(() => {
    setResources([]); setResourcePage(null); setNextFileCursor(null); setNextRecordCursor(null); setResourceTruncated(false)
  }, [query])

  useEffect(() => {
    const raw = query.trim()
    if (raw.length < 2) { setSaid([]); setResources([]); setResourceTruncated(false); return }
    let ignore = false
    const id = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ orgId, q: raw })
        if (resourcePage) {
          if (resourcePage.file) params.set('fileCursor', resourcePage.file); else params.set('skipFiles', '1')
          if (resourcePage.record) params.set('recordCursor', resourcePage.record); else params.set('skipRecords', '1')
        }
        const res = await fetch(`${httpBase}/channels/search?${params}`, { headers: { 'x-session-token': sessionToken } })
        if (!res.ok) return
        const data = await res.json()
        if (ignore) return
        if (!resourcePage) setSaid((data.messages || []).slice(0, 12).map((m: { id: string; channel: string; body: string; authorName: string | null; mine: boolean; kind: string; createdAt: string; parentId?: string | null }) => ({
          key: `m:${m.id}`, group: 'messages' as const,
          label: m.body.replace(/\s+/g, ' ').slice(0, 140),
          meta: `${m.kind === 'ai' ? t('Your AI') : m.mine ? t('You') : (m.authorName || '')} · ${m.createdAt.slice(0, 10)}`,
          action: { kind: 'message' as const, view: m.channel, id: m.id, parentId: m.parentId || null },
        })))
        const fileItems = (data.files || []).slice(0, 8).map((f: { id: string; name: string; scope: string; updatedAt: string; snippet: string }) => ({
          key: `f:${f.id}`, group: 'files' as const, label: f.name,
          meta: `${f.snippet} · ${f.updatedAt.slice(0, 10)}`,
          action: { kind: 'file' as const, fileId: f.id, scope: f.scope },
        }))
        const recordItems = (data.records || []).slice(0, 8).map((r: { appId: string; appName: string; tableId: string; rowId: string; tableName: string; snippet: string; updatedAt: string }) => ({
          key: `r:${r.appId}:${r.rowId}`, group: 'records' as const,
          label: r.snippet, meta: `${r.appName} · ${r.tableName} · ${r.updatedAt.slice(0, 10)}`,
          action: { kind: 'appRecord' as const, appId: r.appId, tableId: r.tableId, rowId: r.rowId },
        }))
        setResources((previous) => {
          const next = resourcePage ? [...previous, ...fileItems, ...recordItems] : [...fileItems, ...recordItems]
          return [...new Map(next.map((item) => [item.key, item])).values()]
        })
        setNextFileCursor(data.filesNextCursor || null)
        setNextRecordCursor(data.recordsNextCursor || null)
        setResourceTruncated(Boolean(data.filesTruncated || data.recordsTruncated))
      } catch { /* the rest of the palette stands */ }
    }, 250)
    return () => { ignore = true; clearTimeout(id) }
  }, [query, httpBase, orgId, sessionToken, t, resourcePage])

  const items = useMemo(() => filtered ? [...said, ...resources] : [...jumps, ...here, ...said, ...resources, ...past, ...actions], [jumps, here, said, resources, past, actions, filtered])
  useEffect(() => { setCursor(0) }, [q, items.length])
  // The highlighted row stays in sight: with conversations above the
  // screens, the arrows walk further than the box is tall. The first row
  // shows its group's heading with it.
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const ul = list.current
    if (!ul) return
    if (cursor === 0) { ul.scrollTop = 0; return }
    ul.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, items])
  // The pointer takes the highlight only by moving. On entering a row it
  // would take it back each time the arrows scroll the list under a pointer
  // left over it, and ↓ past the fold would never get past.
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const onPointer = (i: number) => (e: React.MouseEvent) => {
    const moved = pointerMoved(pointer.current, e)
    pointer.current = { x: e.screenX, y: e.screenY }
    if (moved && i !== cursor) setCursor(i)
  }

  // The arrows are the palette's while it is open: the list's own ⌥↑/⌥↓,
  // on the window, would otherwise change the conversation underneath.
  const onKey = (e: React.KeyboardEvent) => {
    // Mid-word in a Japanese or Chinese input method, Enter picks the word
    // and the arrows pick among candidates: those keys are the IME's.
    if (composing(e)) return
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setCursor((c) => Math.min(c + 1, Math.max(items.length - 1, 0))) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setCursor((c) => Math.max(c - 1, 0)) }
    else if (enterKey(e)) { e.preventDefault(); const it = items[cursor]; if (it) onPick(it.action) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  const GROUP_WORD: Record<Item['group'], string> = { places: t('Conversations'), actions: t('Go to'), cards: t('Cards'), past: t('Decided before'), messages: t('Messages'), files: t('Files'), records: t('App records') }
  /// Before a conversation's name, what kind it is, as the sidebar draws it:
  /// # a channel, a lock a private one, @ a person or an agent, faces a group.
  const placeLead = (p: Place) => (
    <span className="palette-lead" aria-hidden="true">
      {p.kind === 'channel' ? (p.private ? <Icon name="lock" size={13} /> : '#') : p.kind === 'group' ? <Icon name="users" size={14} /> : '@'}
    </span>
  )
  /// After it, what waits there — mentions of you, decisions, or a dot for
  /// something new — each said in words to a screen reader.
  const placeMark = (p: Place) => {
    const mentions = p.mentions || 0
    const unread = p.unread || 0
    if (mentions > 0) return <span className="palette-badge mention"><span aria-hidden="true">@{mentions}</span><span className="sr-only">{mentions === 1 ? t('1 mention of you') : t('{n} mentions of you', { n: mentions })}</span></span>
    if (unread > 0) return <span className="palette-badge"><span aria-hidden="true">{unread}</span><span className="sr-only">{t('{n} waiting on you', { n: unread })}</span></span>
    if (p.fresh) return <span className="palette-fresh"><span className="sr-only">{t('New messages')}</span></span>
    return null
  }
  let lastGroup: Item['group'] | null = null

  return (
    <>
      <div className="scrim palette-scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('Search or jump to')}>
        <input
          ref={input}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={t('Jump to a conversation, or search messages and decisions — from:@name in:#channel…')}
          aria-label={t('Search or jump to')}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[cursor] ? `palette-${items[cursor].key}` : undefined}
          autoComplete="off"
        />
        <div className="palette-filters" role="group" aria-label={t('Filters')}>
          {FILTERS.map((f) => (
            <button key={f.token} type="button" className={`palette-filter${query.includes(f.token) ? ' on' : ''}`} onClick={() => addFilter(f.token)} data-filter={f.token} title={f.token}>
              {f.label}
            </button>
          ))}
          <span className="palette-filter-hint" title={t('search.syntax')}>{t('"exact words" · -without · on:2026-09-01 · in:@name')}</span>
        </div>
        <ul ref={list} className="palette-list" id="palette-list" role="listbox">
          {items.length === 0 && <li className="palette-empty">{t('Nothing matches that.')}</li>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup
            lastGroup = it.group
            return (
              <React.Fragment key={it.key}>
                {head && <li className="palette-group" aria-hidden="true">{GROUP_WORD[it.group]}</li>}
                <li
                  id={`palette-${it.key}`}
                  role="option"
                  aria-selected={i === cursor}
                  className={`palette-item${it.place ? ' palette-place' : ''}${i === cursor ? ' on' : ''}`}
                  data-view={it.place?.view}
                  onMouseMove={onPointer(i)}
                  onClick={() => onPick(it.action)}
                >
                  {it.place && placeLead(it.place)}
                  <span className="palette-label">{it.label}</span>
                  {it.place?.private && <span className="sr-only">{t('Private')}</span>}
                  {it.meta && <span className="palette-meta">{it.meta}</span>}
                  {it.place && placeMark(it.place)}
                </li>
              </React.Fragment>
            )
          })}
        </ul>
        {resourceTruncated && <button className="palette-foot" type="button" onClick={() => setResourcePage({ file: nextFileCursor, record: nextRecordCursor })}>{t('More content matches')}</button>}
        <div className="palette-foot">↑↓ · ⏎ · esc</div>
      </div>
    </>
  )
}
