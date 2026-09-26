import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { DecisionCard } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName } from '../utils/names'
import { useT } from '../utils/i18n'
import type { Screen } from '../utils/route'

export type PaletteAction =
  | { kind: 'card'; cardId: string }
  | { kind: 'screen'; screen: Screen }
  | { kind: 'feed' }
  | { kind: 'list' }
  | { kind: 'compose' }
  | { kind: 'message'; view: string; id: string; parentId?: string | null }

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  cards: DecisionCard[]
  onPick: (action: PaletteAction) => void
  onClose: () => void
}

interface Item { key: string; group: 'actions' | 'cards' | 'past' | 'messages'; label: string; meta?: string; action: PaletteAction }

const ACTION_WORD: Record<string, string> = {
  approve: 'Approved', decline: 'Declined', revise: 'Revision asked',
  choose: 'Chose', reply: 'Replied', acknowledge: 'Acknowledged',
  delegate: 'Delegated', later: 'Deferred', pending: 'Waiting',
}

/// ⌘K. One box that goes anywhere and finds anything: a screen, an action,
/// a card the browser already has, and — a moment later — what the team
/// decided before, from the Worker's search. Enter takes the highlighted
/// row; Escape closes.
export const Palette: React.FC<Props> = ({ httpBase, orgId, sessionToken, cards, onPick, onClose }) => {
  const t = useT()
  const locale = getLocale()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [past, setPast] = useState<Item[]>([])
  const [said, setSaid] = useState<Item[]>([])
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
    const raw = query.trim()
    if (raw.length < 2) { setSaid([]); return }
    let ignore = false
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`${httpBase}/channels/search?orgId=${encodeURIComponent(orgId)}&q=${encodeURIComponent(raw)}`, { headers: { 'x-session-token': sessionToken } })
        if (!res.ok) return
        const data = await res.json()
        if (ignore) return
        setSaid((data.messages || []).slice(0, 12).map((m: { id: string; channel: string; body: string; authorName: string | null; mine: boolean; kind: string; createdAt: string; parentId?: string | null }) => ({
          key: `m:${m.id}`, group: 'messages' as const,
          label: m.body.replace(/\s+/g, ' ').slice(0, 140),
          meta: `${m.kind === 'ai' ? t('Your AI') : m.mine ? t('You') : (m.authorName || '')} · ${m.createdAt.slice(0, 10)}`,
          action: { kind: 'message' as const, view: m.channel, id: m.id, parentId: m.parentId || null },
        })))
      } catch { /* the rest of the palette stands */ }
    }, 250)
    return () => { ignore = true; clearTimeout(id) }
  }, [query, httpBase, orgId, sessionToken, t])

  const items = useMemo(() => filtered ? said : [...here, ...said, ...past, ...actions], [here, said, past, actions, filtered])
  useEffect(() => { setCursor(0) }, [q, items.length])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(items.length - 1, 0))) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[cursor]; if (it) onPick(it.action) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  const GROUP_WORD: Record<Item['group'], string> = { actions: t('Go to'), cards: t('Cards'), past: t('Decided before'), messages: t('Messages') }
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
          placeholder={t('Search messages and decisions — from:@name in:#channel — or type where to go…')}
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
        <ul className="palette-list" id="palette-list" role="listbox">
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
                  className={`palette-item${i === cursor ? ' on' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => onPick(it.action)}
                >
                  <span className="palette-label">{it.label}</span>
                  {it.meta && <span className="palette-meta">{it.meta}</span>}
                </li>
              </React.Fragment>
            )
          })}
        </ul>
        <div className="palette-foot">↑↓ · ⏎ · esc</div>
      </div>
    </>
  )
}
