// @mentions: naming a teammate in what you write.
//
// The rules are shared by every client (packages/core/src/mentions.ts); what
// is here is the web's: loading the team once per workspace, and the hook.

import { useEffect, useState } from 'react'
import type { Mentionable } from '@honmaru/core/mentions'
import { pageShowing } from './desktop'

export * from '@honmaru/core/mentions'

// The team, once per workspace, shared by every box that offers names —
// read again when somebody joins or leaves (the relay says so), and when the
// page comes back into view after a while, in case that word was missed.
const cache = new Map<string, Promise<Mentionable[]>>()
const loadedAt = new Map<string, number>()
const STALE_MS = 60_000

export function loadMembers(httpBase: string, orgId: string, sessionToken: string): Promise<Mentionable[]> {
  const key = `${httpBase}|${orgId}`
  if (!cache.has(key)) {
    loadedAt.set(key, Date.now())
    cache.set(key, fetch(`${httpBase}/members?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((data) => (data.members || []).map((m: { ref: string; name: string; aliases?: string[]; handle?: string | null; mine?: boolean; avatarUrl?: string | null; presence?: string | null }) => ({ ref: m.ref, name: m.name, aliases: m.aliases || [], handle: m.handle || null, mine: Boolean(m.mine), avatarUrl: m.avatarUrl || null, presence: m.presence || null })))
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
    const read = () => loadMembers(httpBase, orgId, sessionToken).then((list) => { if (!ignore) setMembers(list) })
    // Every box that offers names hears the same word: the first one to
    // hear it reads the team again, the rest share that read.
    const again = () => {
      if (Date.now() - (loadedAt.get(`${httpBase}|${orgId}`) || 0) > 2000) forgetMembers(orgId)
      void read()
    }
    const back = () => {
      if (!pageShowing()) return
      const at = loadedAt.get(`${httpBase}|${orgId}`) || 0
      if (Date.now() - at > STALE_MS) again()
    }
    void read()
    window.addEventListener('honmaru:members-changed', again)
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    return () => {
      ignore = true
      window.removeEventListener('honmaru:members-changed', again)
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [httpBase, orgId, sessionToken])
  return members
}
