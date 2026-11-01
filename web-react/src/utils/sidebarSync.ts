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
