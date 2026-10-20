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
// The last team that was read whole. An answer that is not the team — a
// busy server, a rate limit, a dropped connection — is not kept: it hands
// back this one (or nobody, before there is one) and is asked again, rather
// than standing for an empty team until the page is next brought forward.
// An empty team names nobody: no one offered after "@", no @name drawn as
// a mention, and nothing that calls you heard as calling you.
const lastRead = new Map<string, Mentionable[]>()
const STALE_MS = 60_000

type MemberRow = { ref: string; name: string; aliases?: string[]; handle?: string | null; mine?: boolean; avatarUrl?: string | null; presence?: string | null }

export function loadMembers(httpBase: string, orgId: string, sessionToken: string): Promise<Mentionable[]> {
  const key = `${httpBase}|${orgId}`
  if (!cache.has(key)) {
    loadedAt.set(key, Date.now())
    const read: Promise<Mentionable[]> = fetch(`${httpBase}/members?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => { if (!r.ok) throw new Error(`members ${r.status}`); return r.json() })
      .then((data: { members?: MemberRow[] }) => {
        const list = (data.members || []).map((m) => ({ ref: m.ref, name: m.name, aliases: m.aliases || [], handle: m.handle || null, mine: Boolean(m.mine), avatarUrl: m.avatarUrl || null, presence: m.presence || null }))
        lastRead.set(key, list)
        return list
      })
      .catch(() => {
        if (cache.get(key) === read) { cache.delete(key); loadedAt.delete(key) }
        return lastRead.get(key) || []
      })
    cache.set(key, read)
  }
  return cache.get(key)!
}

/// Whether the team for this workspace is held as read, rather than still
/// to be asked for again after an answer that was not it.
export function membersHeld(httpBase: string, orgId: string): boolean {
  return cache.has(`${httpBase}|${orgId}`)
}

export function forgetMembers(orgId?: string): void {
  if (!orgId) { cache.clear(); lastRead.clear(); return }
  for (const key of [...cache.keys()]) if (key.endsWith(`|${orgId}`)) cache.delete(key)
}

export function useMembers(httpBase: string, orgId: string, sessionToken: string): Mentionable[] {
  const [members, setMembers] = useState<Mentionable[]>([])
  useEffect(() => {
    let ignore = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let wait = 2000
    // A read that did not get the team is tried again on its own, a little
    // later each time — not left until the page is next brought forward,
    // which in the desktop app can be hours.
    const read = (): Promise<void> => loadMembers(httpBase, orgId, sessionToken).then((list) => {
      if (ignore) return
      setMembers(list)
      clearTimeout(retry)
      if (membersHeld(httpBase, orgId)) { wait = 2000; return }
      retry = setTimeout(() => { void read() }, wait)
      wait = Math.min(wait * 2, STALE_MS)
    })
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
      clearTimeout(retry)
      window.removeEventListener('honmaru:members-changed', again)
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [httpBase, orgId, sessionToken])
  return members
}
