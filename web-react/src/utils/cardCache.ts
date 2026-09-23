import type { DecisionCard } from '../types/card'

// The last snapshot, kept in this browser, so the inbox has something to
// show before the relay answers — and when it cannot, on a train, with the
// shell served from the service worker. The phone keeps the same thing on
// the device. Per organization, because another workspace's cards shown
// after a switch would be a feed that lies.

const KEY = 'cards'
const MAX_CARDS = 200

interface Envelope { orgId: string; cardsById: Record<string, DecisionCard> }

export function loadCardCache(orgId: string): Record<string, DecisionCard> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const env = JSON.parse(raw) as Envelope
    if (!env || env.orgId !== orgId || typeof env.cardsById !== 'object') return {}
    return env.cardsById
  } catch { return {} }
}

export function saveCardCache(orgId: string, cardsById: Record<string, DecisionCard>): void {
  // Newest first, capped: an old workspace's whole history is not worth a
  // storage quota error on the next write.
  const cards = Object.values(cardsById)
    .sort((a, b) => (b.decision?.decidedAt || b.createdAt).localeCompare(a.decision?.decidedAt || a.createdAt))
    .slice(0, MAX_CARDS)
  const kept: Record<string, DecisionCard> = {}
  for (const c of cards) kept[c.id] = c
  try { localStorage.setItem(KEY, JSON.stringify({ orgId, cardsById: kept } as Envelope)) } catch { /* full, or blocked */ }
}

export function clearCardCache(): void {
  try { localStorage.removeItem(KEY) } catch { /* nothing to clear */ }
}
