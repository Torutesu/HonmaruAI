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

let current: { orgId: string; list: CustomEmoji[]; byName: Map<string, string> } = { orgId: '', list: [], byName: new Map() }
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

function set(orgId: string, list: CustomEmoji[]) {
  current = { orgId, list, byName: new Map(list.map((e) => [e.name, e.url])) }
  emit()
}

/// Fetch this workspace's list. Switching workspaces empties the old one
/// at once, so none of it is drawn in the new one while the fetch runs.
export async function loadCustomEmoji(httpBase: string, sessionToken: string, orgId: string): Promise<CustomEmoji[]> {
  if (current.orgId !== orgId) set(orgId, [])
  try {
    const res = await fetch(`${httpBase}/emoji?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
    if (!res.ok) return current.list
    const data = await res.json() as { emoji?: CustomEmoji[] }
    if (current.orgId === orgId) set(orgId, data.emoji || [])
  } catch { /* the names stay text */ }
  return current.list
}

/// The picture for `:name:` (with or without its colons), if this
/// workspace has one.
export function customEmojiUrl(name: string): string | null {
  return current.byName.get(name.replace(/^:|:$/g, '')) || null
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
