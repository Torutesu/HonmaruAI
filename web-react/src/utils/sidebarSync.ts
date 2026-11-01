// Your sidebar (stars, sections, order) lives on the server, and is saved
// whole. Two answers could undo what you just did with it:
//
// - The sidebar read when the list opens. Starred before it came back, the
//   star was drawn, saved as the empty layout the list started from plus
//   that one star (every other star and section gone from the server), and
//   then the late read put the old layout back on screen.
// - The answer to an earlier save, arriving after a later one.
//
// So a change is kept as what it does, not what it produced: made before
// the server's layout is in, it is shown at once and saved once that layout
// arrives, replayed on top of it. And only the latest save's answer is drawn.

export type LayoutChange<L> = (base: L) => L

// Reorder only entries still in the current base; retain anything another
// device added while the drag was in progress.
export function reorderExisting(current: string[], wanted: string[]): string[] {
  const present = new Set(current)
  const ordered = [...new Set(wanted)].filter(id => present.has(id))
  const known = new Set(ordered)
  return [...ordered, ...current.filter(id => !known.has(id))]
}

// Channel ordering can name new entries that previously had no explicit
// position; retain any entries added by another device after the drag began.
export function reorderIncludingNew(current: string[], wanted: string[]): string[] {
  const ordered = [...new Set(wanted)]
  const known = new Set(ordered)
  return [...ordered, ...current.filter(id => !known.has(id))]
}

export class SidebarSync<L> {
  private loaded = false
  private pending: LayoutChange<L>[] = []
  private saves = 0

  /// A change the person made to what is on screen now. `save` is what to
  /// send, or null while the server's layout is still on its way.
  change(current: L, change: LayoutChange<L>): { next: L; save: L | null } {
    const next = change(current)
    if (this.loaded) return { next, save: next }
    this.pending.push(change)
    return { next, save: null }
  }

  /// The server's layout arrived: what to show, and what to save if
  /// anything was changed while it was on its way.
  arrived(server: L): { next: L; save: L | null } {
    this.loaded = true
    const changes = this.pending
    this.pending = []
    const next = changes.reduce((layout, change) => change(layout), server)
    return { next, save: changes.length ? next : null }
  }

  /// The server's layout could not be read: what was changed meanwhile is
  /// saved over what this list has, as before, rather than never at all.
  unavailable(current: L): L | null {
    if (this.loaded) return null
    this.loaded = true
    const changes = this.pending
    this.pending = []
    return changes.length ? current : null
  }

  /// A save going out. Its answer is drawn only if no later save went out.
  begin(): number { return ++this.saves }
  latest(save: number): boolean { return save === this.saves }
}

export type SidebarSnapshot<L> = { sidebar: L; version?: string | null }
export type SidebarWrite<L> = { conflict: boolean; snapshot: SidebarSnapshot<L> }

// Each local action stays as an operation until the server accepts it. A
// conflict replaces the base, then replays only this device's pending actions.
export class SidebarEditQueue<L> {
  private base: SidebarSnapshot<L> | null = null
  private pending: LayoutChange<L>[] = []
  private running = false
  private detached = false
  private uncertain = false
  private shown: L
  private settled: (() => void) | null = null

  constructor(initial: L, private readonly read: () => Promise<SidebarSnapshot<L>>,
    private readonly write: (sidebar: L, version: string | null | undefined) => Promise<SidebarWrite<L>>,
    private show: (layout: L, ready: boolean, pending: boolean) => void,
    private failed: (uncertain: boolean) => void) { this.shown = initial }

  change(change: LayoutChange<L>): { before: L; next: L } {
    const before = this.shown
    if (this.uncertain) { if (!this.detached) this.failed(true); return {before, next:before} }
    this.pending.push(change)
    this.shown = change(before)
    if (!this.detached) this.show(this.shown, this.base !== null, true)
    void this.retry()
    return { before, next: this.shown }
  }

  async retry(): Promise<void> {
    if (this.running || this.uncertain) return
    this.running = true
    try {
      if (!this.base) {
        const fetched = await this.read()
        this.base = fetched
        this.shown = this.pending.reduce((layout, change) => change(layout), fetched.sidebar)
        if (!this.detached) this.show(this.shown, true, this.hasPending())
      }
      let conflicts = 0
      while (this.pending.length) {
        const batch = this.pending.slice()
        const next = batch.reduce((layout, change) => change(layout), this.base.sidebar)
        let result: SidebarWrite<L>
        try { result = await this.write(next, this.base.version) }
        catch {
          // A dropped response may follow a committed write. Do not replay an
          // operation over a newer change without an idempotency receipt.
          this.uncertain = true
          if (!this.detached) this.failed(true)
          return
        }
        this.base = result.snapshot
        if (!result.conflict) { this.pending.splice(0, batch.length); conflicts = 0 }
        else if (++conflicts >= 8) throw new Error('Sidebar changed repeatedly.')
        this.shown = this.pending.reduce((layout, change) => change(layout), this.base.sidebar)
        if (!this.detached) this.show(this.shown, true, this.hasPending())
      }
    } catch {
      if (!this.detached) this.failed(false)
    } finally {
      this.running = false
      if (this.detached && !this.hasPending()) this.settled?.()
    }
  }

  // Only an explicit user decision may discard the uncertain operations.
  adopt(snapshot: SidebarSnapshot<L>): boolean {
    if (!this.uncertain || this.running || this.detached) return false
    this.pending = []
    this.base = snapshot
    this.shown = snapshot.sidebar
    this.uncertain = false
    this.show(this.shown, true, false)
    return true
  }

  // A workspace switch stops drawing into this component, but a user's
  // already-requested write may finish using its original account context.
  dispose(): void { this.detached = true }

  hasPending(): boolean { return this.pending.length > 0 }

  attach(show: (layout: L, ready: boolean, pending: boolean) => void, failed: (uncertain: boolean) => void): void {
    this.show = show
    this.failed = failed
    this.detached = false
    this.show(this.shown, this.base !== null, this.hasPending())
    if (this.uncertain) this.failed(true)
  }

  whenDetachedSettled(callback: () => void): void { this.settled = callback }
}

// These queues contain only the current browser tab's unfinished operations.
// The key is scoped to the server, session, user, and workspace by the caller.
// A page close still ends in-memory recovery; nothing is written to disk.
const retainedQueues = new Map<string, SidebarEditQueue<any>>()
export function retainSidebarQueue<L>(key: string, queue: SidebarEditQueue<L>): void {
  queue.dispose()
  if (!queue.hasPending()) return
  retainedQueues.set(key, queue)
  queue.whenDetachedSettled(() => { if (retainedQueues.get(key) === queue) retainedQueues.delete(key) })
}
export function takeSidebarQueue<L>(key: string): SidebarEditQueue<L> | null {
  const queue = retainedQueues.get(key) as SidebarEditQueue<L> | undefined
  retainedQueues.delete(key)
  return queue?.hasPending() ? queue : null
}
