import React, { useMemo, useState } from 'react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName } from '../utils/names'
import { sourceLabel } from '../utils/automation'
import { useT, t as tt } from '../utils/i18n'

interface Props {
  pending: DecisionCard[]
  decided: DecisionCard[]
  businesses: Business[]
  selectedId: string | null
  onSelect: (cardId: string) => void
}

const ACTION_WORD: Record<string, string> = {
  approve: 'Approved', decline: 'Declined', revise: 'Revision asked',
  choose: 'Chose', reply: 'Replied', acknowledge: 'Acknowledged',
  delegate: 'Delegated', later: 'Deferred',
}

function ago(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 1) return tt('just now')
  if (mins < 60) return tt('{n}m', { n: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return tt('{n}h', { n: hours })
  return tt('{n}d', { n: Math.round(hours / 24) })
}

/// One line of the inbox. Kept outside `Inbox` on purpose: an inline
/// component is a new type every render, so React would unmount and remount
/// every row each time a card arrives — focus lost mid j/k walk, and any
/// handle a test holds goes stale.
const Row: React.FC<{ card: DecisionCard; meta: string; tone?: string; locale: string; on: boolean; onSelect: (id: string) => void }> =
  ({ card, meta, tone, locale, on, onSelect }) => {
    const l = card.localized?.[locale]
    return (
      <li>
        <button
          type="button"
          className={`inbox-row${on ? ' on' : ''}`}
          aria-current={on ? 'true' : undefined}
          onClick={() => onSelect(card.id)}
          data-card={card.id}
        >
          <span className={`inbox-pri p-${card.priority}`} aria-hidden="true" />
          <span className="inbox-text">
            <span className="inbox-title">{l?.title || card.title}</span>
            <span className="inbox-meta">{meta}</span>
          </span>
          <span className={`inbox-when${tone ? ` ${tone}` : ''}`}>{ago(card.decision?.decidedAt || card.createdAt)}</span>
        </button>
      </li>
    )
  }

/// The left pane of the laptop workbench: everything waiting on you, then
/// what you decided lately, one line each, with a search box on top. Pick a
/// row and the card opens beside it. On a phone none of this renders — the
/// card is the screen there, and this is what the screen would cover.
export const Inbox: React.FC<Props> = ({ pending, decided, businesses, selectedId, onSelect }) => {
  const t = useT()
  const locale = getLocale()
  const [query, setQuery] = useState('')
  const nameOf = useMemo(() => {
    const map = new Map(businesses.map((b) => [b.slug, b.name]))
    return (slug?: string) => (slug ? map.get(slug) || slug : '')
  }, [businesses])

  // Narrow by what matters when there is too much: the business, how hot,
  // how long it has waited. One of each at a time; a chip is a toggle.
  const [business, setBusiness] = useState<string | null>(null)
  const [hot, setHot] = useState(false)
  const [stale, setStale] = useState(false)
  const DAY = 86400000
  const waitingDays = (c: DecisionCard) => Math.floor((Date.now() - Date.parse(c.createdAt)) / DAY)
  const isHot = (c: DecisionCard) => c.priority === 'urgent' || c.priority === 'high'
  const isStale = (c: DecisionCard) => c.status === 'pending' && waitingDays(c) >= 2
  const businessesInUse = businesses.filter((b) => pending.some((c) => c.business === b.slug) || decided.some((c) => c.business === b.slug))

  const q = query.trim().toLowerCase()
  const matches = (c: DecisionCard) => {
    if (business && c.business !== business) return false
    if (hot && !isHot(c)) return false
    if (stale && !isStale(c)) return false
    if (!q) return true
    const l = c.localized?.[locale]
    return [l?.title || c.title, l?.summary || c.summary, c.requestedBy?.name, c.senderUserID, nameOf(c.business), c.sourceApp]
      .some((s) => (s || '').toLowerCase().includes(q))
  }
  const waiting = pending.filter(matches)
  const done = decided.filter(matches).slice(0, 40)

  return (
    <aside className="inbox" aria-label={t('Inbox')}>
      <div className="inbox-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Search decisions')}
          aria-label={t('Search decisions')}
        />
      </div>

      {/* Today, in one line: what is waiting, how much of it is hot, how
          much has waited too long. The numbers a person would otherwise
          count by scrolling. */}
      <p className="inbox-today" role="status">
        {pending.length === 0
          ? t('Nothing is waiting on you.')
          : t('{n} waiting on you', { n: pending.length })
            + (pending.filter((c) => c.priority === 'urgent').length ? ` · ${t('{n} urgent', { n: pending.filter((c) => c.priority === 'urgent').length })}` : '')
            + (pending.filter((c) => c.priority === 'high').length ? ` · ${t('{n} high priority', { n: pending.filter((c) => c.priority === 'high').length })}` : '')
            + (pending.filter(isStale).length ? ` · ${t('{n} older than 2 days', { n: pending.filter(isStale).length })}` : '')}
      </p>
      {(businessesInUse.length > 0 || pending.some(isHot) || pending.some(isStale)) && (
        <div className="inbox-chips" role="group" aria-label={t('Narrow')}>
          {pending.some(isHot) && (
            <button type="button" className={`chip${hot ? ' on' : ''}`} aria-pressed={hot} onClick={() => setHot(!hot)}>{t('High or urgent')}</button>
          )}
          {pending.some(isStale) && (
            <button type="button" className={`chip${stale ? ' on' : ''}`} aria-pressed={stale} onClick={() => setStale(!stale)}>{t('Waiting 2+ days')}</button>
          )}
          {businessesInUse.map((b) => (
            <button
              key={b.slug}
              type="button"
              className={`chip${business === b.slug ? ' on' : ''}`}
              aria-pressed={business === b.slug}
              onClick={() => setBusiness(business === b.slug ? null : b.slug)}
            >{b.name}</button>
          ))}
        </div>
      )}

      <h2 className="inbox-h">{t('Waiting on you')}<span>{waiting.length}</span></h2>
      {waiting.length === 0 && <p className="inbox-empty">{q ? t('Nothing matches that.') : t('Nothing is waiting on you.')}</p>}
      <ul className="inbox-list">
        {waiting.map((c) => (
          <Row
            key={c.id}
            card={c}
            meta={[displayName(c.requestedBy?.name || c.senderUserID), nameOf(c.business), sourceLabel(c, t)].filter(Boolean).join(' · ')}
            locale={locale}
            on={c.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>

      {done.length > 0 && (
        <>
          <h2 className="inbox-h">{t('Decided')}<span>{done.length}</span></h2>
          <ul className="inbox-list">
            {done.map((c) => (
              <Row
                key={c.id}
                card={c}
                meta={[t(ACTION_WORD[c.decision?.action || ''] || c.status), nameOf(c.business)].filter(Boolean).join(' · ')}
                tone="quiet"
                locale={locale}
                on={c.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}
