// Threads, read from a channel's own messages. A channel's history holds
// its replies too (each says its parentId), in order, newest pages first:
// a parent that is held has every reply after it held as well. So a thread
// needs no request of its own — it is a view of what the channel has.

import type { Message } from '../../protocol/src/v2'

/// What the conversation itself shows: messages, and replies sent to it too.
export function inConversation<T extends Message>(messages: T[]): T[] {
  return messages.filter((m) => !m.parentId || m.alsoChannel)
}

export interface ReplyStats { count: number; lastAt: string }

/// How many replies each message has, and when the last came.
export function replyStats(messages: Message[]): Map<string, ReplyStats> {
  const out = new Map<string, ReplyStats>()
  for (const m of messages) {
    if (!m.parentId || m.deletedAt) continue
    const s = out.get(m.parentId)
    if (!s) out.set(m.parentId, { count: 1, lastAt: m.createdAt })
    else { s.count += 1; if (m.createdAt > s.lastAt) s.lastAt = m.createdAt }
  }
  return out
}

/// One thread: the message it hangs off and its replies, oldest first.
/// Null when that message is not held.
export function threadOf<T extends Message>(messages: T[], parentId: string): { parent: T; replies: T[] } | null {
  const parent = messages.find((m) => m.id === parentId)
  if (!parent) return null
  return { parent, replies: messages.filter((m) => m.parentId === parentId && !m.deletedAt) }
}
