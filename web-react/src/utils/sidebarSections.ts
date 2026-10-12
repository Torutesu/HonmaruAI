// The sidebar's sections, folded the way a chat client folds a category:
// the header closes, and what still calls for you stays in view under it.

/// What a folded section needs to know about one of its rows.
export interface SectionRow {
  key: string
  /// The conversation (`b:…`, `dm:…`, `g:…`, `ag:…`); an app has none.
  view?: string
  /// Decision cards waiting on you.
  unread: number
  /// Said since you last looked.
  fresh?: boolean
}

/// How loud each conversation may be, as the prefs route keeps it; a
/// conversation not named is 'all'.
export type Levels = Record<string, 'all' | 'mentions' | 'mute'>

export interface FoldContext {
  /// Unread mentions of you, by conversation.
  mentions: Record<string, number>
  /// The row open now, which a fold never hides.
  currentKey?: string | null
  prefs: Levels
}

/// The rows a folded section still shows, in their order: the one open now,
/// and each with a card waiting, something new said, or a mention. A muted
/// conversation shows only when it names you or a card waits on you there —
/// muting it was asking not to hear what is said, not to lose a decision,
/// whose row stays red when the section is open.
export function foldedRows<T extends SectionRow>(threads: readonly T[], { mentions, currentKey, prefs }: FoldContext): T[] {
  return threads.filter((th) => {
    if (currentKey && th.key === currentKey) return true
    const named = Boolean(th.view && (mentions[th.view] || 0) > 0)
    if (th.view && prefs[th.view] === 'mute') return named || th.unread > 0
    return th.unread > 0 || Boolean(th.fresh) || named
  })
}

/// What a folded section's header says about its rows: the cards waiting
/// (red), the mentions (blue @N), and whether anything new was said — not
/// in the one open now, whose row shows no dot either (you are reading it,
/// or just marked it unread while still looking).
export function sectionBadge(threads: readonly SectionRow[], mentions: Record<string, number>, currentKey?: string | null): { cards: number; mentions: number; fresh: boolean } {
  let cards = 0
  let named = 0
  let fresh = false
  for (const th of threads) {
    cards += th.unread
    if (th.view) named += mentions[th.view] || 0
    if (th.fresh && th.key !== currentKey) fresh = true
  }
  return { cards, mentions: named, fresh }
}

/// Every row the sidebar shows, top to bottom — what ⌥↑/⌥↓ walks, so it
/// never lands on a row a folded section hides.
export function visibleRows<T extends SectionRow>(sections: Array<{ id: string; threads: T[] }>, folded: Record<string, boolean>, context: FoldContext): T[] {
  return sections.flatMap((s) => (folded[s.id] ? foldedRows(s.threads, context) : s.threads))
}

/// The row ⌥↓ (or ⌥↑) goes to from the one open now, round the ends. When
/// the open one is not among them — Activity is up and its section is
/// folded — ⌥↓ starts at the top and ⌥↑ at the bottom.
export function stepRow<T extends { key: string }>(rows: T[], currentKey: string | null | undefined, down: boolean): T | undefined {
  if (!rows.length) return undefined
  const i = rows.findIndex((x) => x.key === currentKey)
  if (i < 0) return down ? rows[0] : rows[rows.length - 1]
  return rows[(i + (down ? 1 : -1) + rows.length) % rows.length]
}

const foldsKey = (orgId: string) => `sidebar.folded:${orgId}`

/// The sections folded in this workspace, as this browser remembers them:
/// `channels`, `people`, `sec:<id>` and the rest, by the id section() gets.
export function readFolds(orgId: string): Record<string, boolean> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(foldsKey(orgId)) || '[]')
    if (!Array.isArray(ids)) return {}
    return Object.fromEntries(ids.filter((id): id is string => typeof id === 'string').map((id) => [id, true]))
  } catch { return {} }
}

/// Remembered for the next visit; only the folded ones are kept.
export function writeFolds(orgId: string, folded: Record<string, boolean>) {
  try {
    const ids = Object.keys(folded).filter((id) => folded[id])
    if (ids.length) localStorage.setItem(foldsKey(orgId), JSON.stringify(ids))
    else localStorage.removeItem(foldsKey(orgId))
  } catch { /* folded until the page is reloaded */ }
}

/// Your own sections fold as the server keeps them — alike on the laptop
/// and the phone — and one that is gone is forgotten. The built-in ones
/// stay as this browser has them.
export function withSectionFolds(folded: Record<string, boolean>, sections: Array<{ id: string; collapsed?: boolean }>): Record<string, boolean> {
  const next: Record<string, boolean> = {}
  for (const id of Object.keys(folded)) if (folded[id] && !id.startsWith('sec:')) next[id] = true
  for (const s of sections) if (s.collapsed) next[`sec:${s.id}`] = true
  return next
}

/// One of your sections folded, or opened again, and the rest as they were:
/// all a fold changes in the sidebar this window holds, as it is all the
/// server writes for one.
export function withFold<T extends { id: string; collapsed?: boolean }>(sections: T[], id: string, collapsed: boolean): T[] {
  return sections.map((s) => (s.id === id ? { ...s, collapsed } : s))
}

/// What is starred and what your sections hold, as the sidebar keeps it.
interface Placed { starred: string[]; sections: Array<{ views: string[] }> }

/// The agents whose conversation was starred or in a section and, after a
/// change to the sidebar, is in neither. One nothing has been said in yet
/// was listed only for being placed: it is kept listed, back among the
/// agents, rather than vanishing — from under you, if it is the one open.
export function unplacedAgents(before: Placed, after: Placed): string[] {
  const views = (l: Placed) => new Set([...l.starred, ...l.sections.flatMap((x) => x.views)])
  const still = views(after)
  return [...views(before)].filter((v) => v.startsWith('ag:') && !still.has(v)).map((v) => v.slice(3))
}
