import { useSyncExternalStore } from 'react'

// The workspace's own emoji, for whatever draws a message or a reaction.
//
// One list, for the workspace open now: fetched when it opens and again when
// somebody adds or removes one here. `:name:` is drawn as its picture only
// when the name is in this list — in any other workspace, or before the
// list arrives, it stays the text it was.

export interface CustomEmoji {
  name: string
  url: string
  by: string | null
  createdAt: string
}

// `missing`: pictures that would not load even after the list was read
// again. Their names are drawn as text, never as a broken picture.
let current: { orgId: string; list: CustomEmoji[]; byName: Map<string, string>; missing: Set<string> } = { orgId: '', list: [], byName: new Map(), missing: new Set() }
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

// A fresh list tries every picture again: one that failed on a bad
// connection gets its chance back.
function set(orgId: string, list: CustomEmoji[]) {
  current = { orgId, list, byName: new Map(list.map((e) => [e.name, e.url])), missing: new Set() }
  emit()
}

// Where the list was last read from, so a picture that fails can ask again.
let source: { httpBase: string; sessionToken: string; orgId: string } | null = null
const recheckedAt = new Map<string, number>()

/// Fetch this workspace's list. Switching workspaces empties the old one
/// at once, so none of it is drawn in the new one while the fetch runs.
export async function loadCustomEmoji(httpBase: string, sessionToken: string, orgId: string): Promise<CustomEmoji[]> {
  if (current.orgId !== orgId) { set(orgId, []); recheckedAt.clear() }
  source = { httpBase, sessionToken, orgId }
  try {
    const res = await fetch(`${httpBase}/emoji?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
    if (!res.ok) return current.list
    const data = await res.json() as { emoji?: CustomEmoji[] }
    if (current.orgId === orgId) set(orgId, data.emoji || [])
  } catch { /* the names stay text */ }
  return current.list
}

/// The picture for `:name:` (with or without its colons), if this
/// workspace has one and it loads.
export function customEmojiUrl(name: string): string | null {
  const url = current.byName.get(name.replace(/^:|:$/g, '')) || null
  return url && !current.missing.has(url) ? url : null
}

/// A picture would not load: removed by somebody else, or replaced under the
/// same name, while this list was open. Read the list again (once a minute
/// at most for one picture): a replaced one comes back at its new address,
/// a removed one goes back to being text. One still listed that still does
/// not load is drawn as text too.
export async function customEmojiFailed(url: string, now = Date.now()): Promise<void> {
  if (!source || current.missing.has(url)) return
  const asked = now - (recheckedAt.get(url) || 0) < 60_000
  if (!asked) {
    recheckedAt.set(url, now)
    const { httpBase, sessionToken, orgId } = source
    await loadCustomEmoji(httpBase, sessionToken, orgId)
    if (current.orgId !== orgId) return
  }
  if ([...current.byName.values()].includes(url)) {
    current = { ...current, missing: new Set([...current.missing, url]) }
    emit()
  }
}

export function customEmojiList(): CustomEmoji[] {
  return current.list
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const snapshot = () => current

/// Re-render when the list changes.
export function useCustomEmoji(): CustomEmoji[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot).list
}

export const CUSTOM_EMOJI = /^:([a-z0-9_+-]{1,30}):$/

/// A name the Worker will take, from what somebody typed or a file's name.
export function emojiNameFrom(raw: string): string {
  return raw
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/^:+|:+$/g, '')
    .toLowerCase()
    .replace(/[\s.]+/g, '_')
    .replace(/[^a-z0-9_+-]/g, '')
    .slice(0, 30)
}
