import type { ChannelMessage } from '../types/card'

export interface ChannelActivity {
  channel: string
  lastAt: string
  preview: string
  lastBy: string | null
  last?: ChannelMessage
}

// Socket delivery and React's message-state updater do not run in lockstep.
// Order the sidebar independently, so deferred rendering cannot lose news.
export function receiveChannelActivity(previous: Record<string, ChannelActivity>, message: ChannelMessage): Record<string, ChannelActivity> {
  if (message.deleted || message.editedAt || (message.parentId && !message.alsoChannel)) return previous
  const current = previous[message.channel]
  if (current && current.lastAt >= message.createdAt) return previous
  return { ...previous, [message.channel]: {
    channel: message.channel, lastAt: message.createdAt,
    preview: message.body.slice(0, 120), lastBy: message.mine ? 'me' : message.authorName || null,
    last: message,
  } }
}
