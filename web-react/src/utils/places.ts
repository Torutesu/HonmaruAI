import { roomNameMatches } from './roomNameSearch'

// The quick switcher's half of ⌘K: every conversation you can open — a
// channel, a DM, a group DM, an agent — found by a few letters of its name,
// the way a chat client's switcher finds it. Typing a channel's name used to
// find only messages that mentioned it.

/// One conversation, as the switcher lists it.
export interface Place {
  /// Where it opens: `b:<slug>`, `dm:<ref>`, `g:<id>` or `ag:<id>`.
  view: string
  kind: 'channel' | 'person' | 'group' | 'agent'
  name: string
  /// A second name it answers to: a person's or an agent's @handle, a
  /// channel's slug.
  handle?: string
  /// A channel only its members see.
  private?: boolean
  /// Decisions waiting on you in it.
  unread?: number
  /// Unread mentions of you in it.
  mentions?: number
  /// Said since you last looked.
  fresh?: boolean
}

/// A conversation as the sidebar holds it, as much of it as the switcher reads.
export interface SidebarConversation {
  kind: string
  view?: string
  name: string
  handle?: string | null
  private?: boolean
  unread?: number
  fresh?: boolean
}

const PLACE_KINDS: ReadonlySet<string> = new Set(['channel', 'person', 'group', 'agent'])

/// The sidebar's conversations as places, each with the mentions waiting in
/// it. Only one with somewhere to open is a place: an app's decisions and a
/// former teammate's have no conversation to go to.
export function placesFrom(list: SidebarConversation[], mentionsIn: Record<string, number>): Place[] {
  const out: Place[] = []
  for (const c of list) {
    if (!c.view || !PLACE_KINDS.has(c.kind)) continue
    out.push({
      view: c.view, kind: c.kind as Place['kind'], name: c.name,
      ...(c.handle ? { handle: c.handle } : {}),
      ...(c.private ? { private: true } : {}),
      unread: c.unread || 0, mentions: mentionsIn[c.view] || 0, fresh: Boolean(c.fresh),
    })
  }
  return out
}

/// Before the list has ever drawn its sidebar — the cards, straight after
/// signing in — the switcher still knows the workspace's channels and who is
/// on the team: a channel, or a DM with any of them, opens from here. What is
/// unread is the sidebar's to know, so none of these calls for you.
export function placesFallback(
  channels: Array<{ slug: string; name: string; private?: boolean }>,
  team: Array<{ ref: string; name: string; handle?: string | null; mine?: boolean }>,
): Place[] {
  return [
    ...channels.map((b): Place => ({ view: `b:${b.slug}`, kind: 'channel', name: b.name || b.slug, handle: b.slug, ...(b.private ? { private: true } : {}) })),
    ...team.filter((m) => !m.mine).map((m): Place => ({ view: `dm:${m.ref}`, kind: 'person', name: m.name, ...(m.handle ? { handle: m.handle } : {}) })),
  ]
}

/// The same letters however they were typed: full-width forms folded
/// (＃ is #, ｇ is g), case ignored.
const fold = (s: string) => s.normalize('NFKC').toLowerCase()

/// A letter or a digit, in any script: what a word is made of.
const WORDY = /[\p{L}\p{N}]/u
const wordStart = (text: string, i: number) => i === 0 || !WORDY.test(text[i - 1])

/// How well what was typed names this text: 5 exactly, 4 at its start, 3 at
/// the start of a word in it, 2 anywhere in it, 1 as letters in order from
/// the start of a word ("gnrl" is general), 0 not at all. The fuzzy match
/// starts on a word so two letters do not find every name that has them.
function matchScore(text: string, q: string): number {
  if (!text || !q) return 0
  if (text === q) return 5
  if (text.startsWith(q)) return 4
  let at = text.indexOf(q)
  if (at >= 0) {
    for (; at >= 0; at = text.indexOf(q, at + 1)) if (wordStart(text, at)) return 3
    return 2
  }
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== q[0] || !wordStart(text, i)) continue
    let k = 1
    for (let j = i + 1; j < text.length && k < q.length; j += 1) if (text[j] === q[k]) k += 1
    if (k === q.length) return 1
  }
  return 0
}

/// Someone is asking for you in it: a mention, or a decision waiting.
const asking = (p: Place) => (p.mentions || 0) > 0 || (p.unread || 0) > 0

/// Something in it calls for you: a mention, a decision, or something said.
const calling = (p: Place) => asking(p) || Boolean(p.fresh)

/// Mentions first, then decisions waiting, then anything new — the order the
/// sidebar's badges shout in.
const byAttention = (a: Place, b: Place) =>
  (b.mentions || 0) - (a.mentions || 0)
  || Number((b.unread || 0) > 0) - Number((a.unread || 0) > 0)
  || Number(Boolean(b.fresh)) - Number(Boolean(a.fresh))

/// Where each view is in the recent list; one never opened comes after all.
const recencyOf = (recent: string[]) => {
  const at = new Map(recent.map((v, i) => [v, i] as const))
  return (p: Place) => at.get(p.view) ?? Number.MAX_SAFE_INTEGER
}

/// How many of the conversations asking for you come before where you were:
/// enough to see who wants you, never so many that the way back falls off
/// the list.
const ASKING_MAX = 4

/// With nothing typed: the conversation you were in before this one, first,
/// so ⌘K then Enter goes back to it; then a few that ask for you (mentions,
/// decisions); then where you were lately, most recent first; then the rest
/// of what calls for you, anything merely new last. Nothing else — the whole
/// sidebar is not a suggestion. A busy workspace has something new in every
/// channel, and that alone must not push the way back off the list.
export function emptyQueryPlaces(places: Place[], recent: string[], limit = 8): Place[] {
  const recency = recencyOf(recent)
  const byView = new Map(places.map((p) => [p.view, p] as const))
  const lately = recent.map((v) => byView.get(v)).filter((p): p is Place => Boolean(p))
  const loud = places
    .map((p, i) => ({ p, i }))
    .filter((x) => calling(x.p))
    .sort((a, b) => byAttention(a.p, b.p) || recency(a.p) - recency(b.p) || a.i - b.i)
    .map((x) => x.p)
  // Each once, however the stored list came to name one twice.
  const out: Place[] = []
  const shown = new Set<string>()
  const add = (p: Place) => { if (!shown.has(p.view)) { shown.add(p.view); out.push(p) } }
  if (lately.length) add(lately[0])
  loud.filter((p) => asking(p) && !shown.has(p.view)).slice(0, ASKING_MAX).forEach(add)
  lately.forEach(add)
  loud.forEach(add)
  return out.slice(0, limit)
}

/// The conversations that match what was typed, best first: its name or
/// handle starting with it, then a word in it starting with it, then
/// containing it, then its letters in order. A tie goes to what calls for
/// you, then to where you were most recently. A leading # looks only at
/// channels, a leading @ only at people and agents — what has an @handle
/// to type; a group DM has none — and either on its own lists them all.
export function rankPlaces(places: Place[], query: string, recent: string[], limit = 8, tolerateRoomTypos = false): Place[] {
  let q = fold(query.trim())
  let pool = places
  if (q.startsWith('#')) { pool = places.filter((p) => p.kind === 'channel'); q = q.slice(1).trim() }
  else if (q.startsWith('@')) { pool = places.filter((p) => p.kind === 'person' || p.kind === 'agent'); q = q.slice(1).trim() }
  else if (!q) return emptyQueryPlaces(places, recent, limit)
  if (!q) {
    const first = emptyQueryPlaces(pool, recent, limit)
    const shown = new Set(first.map((p) => p.view))
    return [...first, ...pool.filter((p) => !shown.has(p.view))].slice(0, limit)
  }
  const recency = recencyOf(recent)
  return pool
    .map((p, i) => {
      const name = fold(p.name), handle = fold(p.handle || '').replace(/^@/, '')
      const regular = Math.max(matchScore(name, q), matchScore(handle, q))
      // Workspace Find additionally catches one-character Room typos. Keep
      // the looser match opt-in so Simple mode retains its existing ranking.
      const typo = tolerateRoomTypos && p.kind === 'channel' && q.length >= 4
        && (roomNameMatches(q, p.name) || roomNameMatches(q, p.handle || '')) ? 1.5 : 0
      return { p, i, score: Math.max(regular, typo) }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byAttention(a.p, b.p) || recency(a.p) - recency(b.p) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.p)
}

/// The view just opened, first; each view once; no more than `max`.
export function pushRecent(list: string[], view: string, max = 10): string[] {
  return [view, ...list.filter((v) => v !== view)].slice(0, max)
}

/// Where you were lately, in this browser, per workspace: two teams'
/// #general are not one place.
const recentKey = (orgId: string) => `palette.recent:${orgId}`

export function loadRecent(orgId: string): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(recentKey(orgId)) || '[]')
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string').slice(0, 10) : []
  } catch { return [] }
}

/// A conversation opened: remembered as the most recent.
export function rememberRecent(orgId: string, view: string): void {
  try { localStorage.setItem(recentKey(orgId), JSON.stringify(pushRecent(loadRecent(orgId), view))) } catch { /* private mode: nothing remembered */ }
}
