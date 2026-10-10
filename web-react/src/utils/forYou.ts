/// The server's word that a message is for you, paired with the message.
///
/// The Worker decides who a message is for — a direct or group message, an
/// @mention, a keyword, a reply to you, a thread you wrote in — when it
/// queues the phones' pushes, and tells each of those people's open apps
/// the same thing (`message_for_you`). A desktop app has no push service of
/// its own, so that is what it shows a notification for: exactly what the
/// phone is told, rather than the narrower guess it used to make from the
/// message alone. The word and the message arrive separately, in either
/// order, so each waits a while for the other; and a message is shown once,
/// whichever way it was found to be for you.

export interface Waiting<M> { message?: M; reason?: string; at: number }

export class ForYou<M extends { id: string }> {
  private waiting = new Map<string, Waiting<M>>()
  private shown = new Set<string>()
  constructor(private keepMs = 120_000) {}

  /// A message arrived. Back, when the server already said it is for you.
  message(m: M, now = Date.now()): M | null {
    this.prune(now)
    const w = this.waiting.get(m.id) || { at: now }
    if (!w.message) w.message = m
    this.waiting.set(m.id, w)
    return w.reason ? w.message : null
  }

  /// The server said a message is for you. Back, when it already arrived.
  flag(id: string, reason: string, now = Date.now()): M | null {
    this.prune(now)
    const w = this.waiting.get(id) || { at: now }
    w.reason = reason
    this.waiting.set(id, w)
    return w.message || null
  }

  /// Whether a message is still to be shown; once asked, it is not again.
  take(id: string): boolean {
    if (this.shown.has(id)) return false
    this.shown.add(id)
    return true
  }

  private prune(now: number) {
    for (const [id, w] of this.waiting) if (now - w.at > this.keepMs) this.waiting.delete(id)
    if (this.shown.size > 2000) this.shown = new Set([...this.shown].slice(-1000))
  }
}
