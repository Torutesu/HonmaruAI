import React, { useMemo, useState } from 'react'
import type { DecisionCard, Business } from '../types/card'
import { getLocale } from '../utils/locale'
import { displayName } from '../utils/names'
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

  const q = query.trim().toLowerCase()
  const matches = (c: DecisionCard) => {
    if (!q) return true
    const l = c.localized?.[locale]
    return [l?.title || c.title, l?.summary || c.summary, c.requestedBy?.name, c.senderUserID, nameOf(c.business), c.sourceApp]
      .some((s) => (s || '').toLowerCase().includes(q))
  }
  const waiting = pending.filter(matches)
  const done = decided.filter(matches).slice(0, 40)

  const Row: React.FC<{ card: DecisionCard; meta: string; tone?: string }> = ({ card, meta, tone }) => {
    const l = card.localized?.[locale]
    const on = card.id === selectedId
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

      <h2 className="inbox-h">{t('Waiting on you')}<span>{waiting.length}</span></h2>
      {waiting.length === 0 && <p className="inbox-empty">{q ? t('Nothing matches that.') : t('Nothing is waiting on you.')}</p>}
      <ul className="inbox-list">
        {waiting.map((c) => (
          <Row
            key={c.id}
            card={c}
            meta={[displayName(c.requestedBy?.name || c.senderUserID), nameOf(c.business), c.sourceApp].filter(Boolean).join(' · ')}
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
              />
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}
