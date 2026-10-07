// What this device has marked read, so that a list fetched before it does
// not bring the unread back (#217). Activity and Threads are loaded when
// they open and again behind every change; a load that left before "Mark
// all as read" — or before the read reached the server — answers with the
// old unread flags, and used to overwrite the read just made.
//
// Read only ever moves forward here: an item marked read stays read for
// this session (each Activity item is one event, it cannot be new again),
// a conversation is read up to a time, a thread up to its newest reply
// read. A reply that comes after that is new, and stays new.

interface ActivityLike { key?: string; unread: boolean; at?: string; message: { channel: string; parentId?: string | null; createdAt: string } }
interface ThreadLike { unread: boolean; lastReplyAt: string; parent: { id: string } }

const later = (a: string | undefined, b: string) => (!a || b > a ? b : a)

export class ReadGuard {
  private items = new Set<string>()
  private channels = new Map<string, string>()
  private threads = new Map<string, string>()
  /// When the newest list of each kind was asked for: an answer to an older
  /// question that comes back later is not drawn over a newer one.
  private asked = new Map<string, number>()
  private shown = new Map<string, number>()
  private tick = 0

  /// Activity items looked at, by key.
  readItems(keys: Iterable<string>) { for (const k of keys) this.items.add(k) }
  /// A conversation read up to `at` (its own messages, not its threads').
  readChannel(channel: string, at: string) { this.channels.set(channel, later(this.channels.get(channel), at)) }
  /// A thread read up to `at`: its replies to then, in Threads and Activity.
  readThread(parentId: string, at: string) { this.threads.set(parentId, later(this.threads.get(parentId), at)) }

  /// A load of `kind` leaving now; pass what it returns to `fresh`.
  ask(kind: string): number { const n = ++this.tick; this.asked.set(kind, n); return n }
  /// Whether this answer is still worth drawing: none newer has been.
  fresh(kind: string, ticket: number): boolean {
    if (ticket < (this.shown.get(kind) || 0)) return false
    this.shown.set(kind, ticket)
    return true
  }

  activity<T extends ActivityLike>(list: T[], keyOf: (i: T) => string): T[] {
    return list.map((i) => {
      if (!i.unread) return i
      const at = i.at || i.message.createdAt
      const parent = i.message.parentId
      const read = this.items.has(keyOf(i))
        || (!parent && (this.channels.get(i.message.channel) || '') >= at)
        || (Boolean(parent) && (this.threads.get(parent!) || '') >= at)
      return read ? { ...i, unread: false } : i
    })
  }

  threadList<T extends ThreadLike>(list: T[]): T[] {
    return list.map((x) => (x.unread && (this.threads.get(x.parent.id) || '') >= x.lastReplyAt ? { ...x, unread: false } : x))
  }
}
