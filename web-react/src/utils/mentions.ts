// @mentions: naming a teammate in what you write.
//
// The composer and the thread both offer the team's names when you type "@",
// and both send the refs of whoever you named — the Worker resolves those
// against the real member list, so a name that is nobody's names nobody.

import { useEffect, useState } from 'react'

export interface Mentionable {
  ref: string
  /// This is you.
  mine?: boolean
  avatarUrl?: string | null
  name: string
  /// Other names they answer to, when the profile carries them.
  aliases?: string[]
  /// Their username: what @ writes, when they have one.
  handle?: string | null
  /// A line under the name: a group's size, an agent's job.
  title?: string
  /// One of the team's agents: drawn with its emoji and an "Agent" tag.
  agent?: boolean
  emoji?: string | null
}

/// An agent as the workspace lists it (GET /channels, /channels/agents).
export interface AgentFace {
  id: string
  handle: string
  name: string
  emoji?: string | null
  description?: string
  scope?: 'team' | 'personal'
}

/// The team's agents as names "@" offers: `@hayao` is written by its handle,
/// found by its name too. A handle a person or group already offers is left
/// to them — the server would not have let it be made, but a list loaded a
/// moment apart can disagree.
export function agentMentionables(agents: AgentFace[], taken: Mentionable[] = []): Mentionable[] {
  const fold = (x: string) => x.normalize('NFKC').toLowerCase()
  const used = new Set(taken.map((m) => fold(m.handle || '')).filter(Boolean))
  const seen = new Set<string>()
  const out: Mentionable[] = []
  for (const a of agents) {
    const h = fold(a.handle || '')
    if (!h || used.has(h) || seen.has(h)) continue
    seen.add(h)
    out.push({ ref: `agent:${a.id}`, name: a.name || a.handle, handle: a.handle, title: a.description || undefined, agent: true, emoji: a.emoji || null })
  }
  return out
}

/// The `@` token the caret is inside, if any: where it starts and what has
/// been typed so far. `null` when the caret is not in one.
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/[\s(（「]/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (/[\s@,，。、!?！？:;)）」]/.test(query)) return null
  if (query.length > 40) return null
  return { start: at, query }
}

const fold = (s: string) => s.normalize('NFKC').toLowerCase()

/// Who matches what has been typed so far, best first: a name that starts
/// with it, then one that contains it. Empty query: everyone.
export function matchMembers(members: Mentionable[], query: string, limit = 6): Mentionable[] {
  const q = fold(query.trim())
  const score = (m: Mentionable) => {
    const names = [m.handle || '', m.name, ...(m.aliases || [])].filter(Boolean).map(fold)
    if (!q) return 1
    if (names.some((n) => n.startsWith(q))) return 3
    if (names.some((n) => n.split(/\s+/).some((w) => w.startsWith(q)))) return 2
    if (names.some((n) => n.includes(q))) return 1
    return 0
  }
  return members
    .map((m) => ({ m, s: score(m) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.m.name.localeCompare(b.m.name))
    .slice(0, limit)
    .map((x) => x.m)
}

/// The text with the current `@query` replaced by `@Name ` and where the
/// caret should land afterwards.
export function insertMention(text: string, caret: number, member: Mentionable): { text: string; caret: number } {
  const q = mentionQuery(text, caret)
  if (!q) return { text, caret }
  // The username when there is one — it is exact and has no spaces; else
  // the first name, which the Worker also matches.
  const label = `@${member.handle || member.name.split(/\s+/)[0] || member.name} `
  const next = text.slice(0, q.start) + label + text.slice(caret)
  return { text: next, caret: q.start + label.length }
}

/// The members a text names, by first name, whole name or alias.
export function mentionedRefs(text: string, members: Mentionable[]): string[] {
  const refs = new Set<string>()
  const re = /(^|[\s(（「])@([^\s@,，。、!?！？:;)）」]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const want = fold(m[2])
    const hit = members.find((mem) => {
      const names = [mem.handle || '', mem.name, mem.name.split(/\s+/)[0], ...(mem.aliases || [])].filter(Boolean).map(fold)
      return names.includes(want)
    })
    if (hit) refs.add(hit.ref)
  }
  return [...refs]
}

/// A line of text split so every `@Name` can be drawn as a mention.
export function splitMentions(text: string): Array<{ text: string; mention: boolean }> {
  const out: Array<{ text: string; mention: boolean }> = []
  const re = /(^|[\s(（「])(@[^\s@,，。、!?！？:;)）」]+)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length
    if (start > last) out.push({ text: text.slice(last, start), mention: false })
    out.push({ text: m[2], mention: true })
    last = start + m[2].length
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false })
  return out
}

// The team, once per workspace per page load: every box that offers names
// reads the same list.
const cache = new Map<string, Promise<Mentionable[]>>()

export function loadMembers(httpBase: string, orgId: string, sessionToken: string): Promise<Mentionable[]> {
  const key = `${httpBase}|${orgId}`
  if (!cache.has(key)) {
    cache.set(key, fetch(`${httpBase}/members?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((data) => (data.members || []).map((m: { ref: string; name: string; aliases?: string[]; handle?: string | null; mine?: boolean; avatarUrl?: string | null }) => ({ ref: m.ref, name: m.name, aliases: m.aliases || [], handle: m.handle || null, mine: Boolean(m.mine), avatarUrl: m.avatarUrl || null })))
      .catch(() => { cache.delete(key); return [] }))
  }
  return cache.get(key)!
}

export function forgetMembers(orgId?: string): void {
  if (!orgId) { cache.clear(); return }
  for (const key of [...cache.keys()]) if (key.endsWith(`|${orgId}`)) cache.delete(key)
}

export function useMembers(httpBase: string, orgId: string, sessionToken: string): Mentionable[] {
  const [members, setMembers] = useState<Mentionable[]>([])
  useEffect(() => {
    let ignore = false
    loadMembers(httpBase, orgId, sessionToken).then((list) => { if (!ignore) setMembers(list) })
    return () => { ignore = true }
  }, [httpBase, orgId, sessionToken])
  return members
}
