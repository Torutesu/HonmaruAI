import type { ChannelMessage } from '../types/card'

// A delayed edit/reply event may carry the pin state from before a completed
// pin request. Keep unrelated fresh fields, but never roll that state back.
export function newerPin(previous: ChannelMessage | undefined, next: ChannelMessage): ChannelMessage {
  if (previous?.id === next.id && !next.deleted && (previous.pinVersion || 0) > (next.pinVersion || 0)) {
    return { ...next, pinned: previous.pinned, pinVersion: previous.pinVersion }
  }
  return next
}
