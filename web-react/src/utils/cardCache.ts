import { clearMessageCaches } from './channelMessageCache'
import { forgetTranslations, invalidateTranslationRequests } from './translationCache'
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
/// did not go (outbox:, the old per-workspace key as well), its own AI key,
/// the translations it was given.
/// The next person at this machine starts from nothing of it. The device's
/// own choices — the relay, the language, the theme — stay.
const ACCOUNT_KEYS = ['senderContext', 'aiKey', 'orgId', 'draft:', 'hx-app-draft:', 'daily-draft:', 'card-draft:', 'ask-draft:', 'onboard.tools:', 'sidebar.folded:', 'outbox:', 'emoji.recent', 'translations:']
export function clearAccountData(storage: Storage = localStorage): void {
  clearCardCache()
  clearMessageCaches()
  forgetTranslations()
  try {
    const gone: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i) || ''
      if (ACCOUNT_KEYS.some((p) => k === p || k.startsWith(p.endsWith(':') ? p : `${p}:`))) gone.push(k)
    }
    for (const k of gone) storage.removeItem(k)
  } catch { /* blocked storage: nothing kept to clear */ }
}

// Whose those things are: the server and the account they were kept for.
// They are stored under the workspace alone, so whatever way the last
// account left — signed out, a session that ran out while the app was
// closed, an answer that landed after it had gone — the next one to sign in
// here must start from none of it.
const OWNER_KEY = 'account.owner'
export const accountOwner = (server: string, userId: string): string => `${server}|${userId}`

/// A sign-in: what this browser kept is this account's only if it says so.
/// Anything else — another account's, another server's, or kept by nobody
/// known (from before this was recorded, or written after a sign-out) — is
/// cleared first.
export function claimAccountData(owner: string, storage: Storage = localStorage): void {
  invalidateTranslationRequests()
  let kept: string | null = null
  try { kept = storage.getItem(OWNER_KEY) } catch { /* blocked */ }
  if (kept !== owner) clearAccountData(storage)
  try { storage.setItem(OWNER_KEY, owner) } catch { /* blocked */ }
}

/// A session this browser already had, found still good on opening: what it
/// kept is that account's unless it was recorded as someone else's.
export function adoptAccountData(owner: string, storage: Storage = localStorage): void {
  invalidateTranslationRequests()
  let kept: string | null = null
  try { kept = storage.getItem(OWNER_KEY) } catch { /* blocked */ }
  if (kept && kept !== owner) clearAccountData(storage)
  try { storage.setItem(OWNER_KEY, owner) } catch { /* blocked */ }
}

/// The account is gone from this browser: all it kept goes with it.
export function releaseAccountData(storage: Storage = localStorage): void {
  clearAccountData(storage)
  try { storage.removeItem(OWNER_KEY) } catch { /* blocked */ }
}
