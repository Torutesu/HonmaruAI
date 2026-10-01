import { clearMessageCaches } from './channelMessageCache'
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

/// Everything this browser kept for the account signing out: its cards, its
/// "How I work" per workspace, its unsent drafts, the messages it sent that
/// did not go (outbox:, the old per-workspace key as well), its own AI key.
/// The next person at this machine starts from nothing of it. The device's
/// own choices — the relay, the language, the theme — stay.
const ACCOUNT_KEYS = ['senderContext', 'aiKey', 'orgId', 'draft:', 'daily-draft:', 'onboard.tools:', 'sidebar.folded:', 'outbox:', 'emoji.recent']
export function clearAccountData(storage: Storage = localStorage): void {
  clearCardCache()
  clearMessageCaches()
  try {
    const gone: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i) || ''
      if (ACCOUNT_KEYS.some((p) => k === p || k.startsWith(p.endsWith(':') ? p : `${p}:`))) gone.push(k)
    }
    for (const k of gone) storage.removeItem(k)
  } catch { /* blocked storage: nothing kept to clear */ }
}
