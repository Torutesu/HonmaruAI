import { useEffect, useRef } from 'react'

// Back, in the list: the phone's back gesture, a browser's Back button or a
// mouse's back key closes what was opened last (a member list, a profile, a
// thread, a card, the conversation itself on a phone) — not the whole list.
// Opening a pane adds no address of its own, so without this, Back went to
// whatever came before the list: most often the cards.
//
// Each layer open is one history entry, all at the list's own address, marked
// with this stack's id and its depth. Back to a lower depth closes the layers
// above it; a layer closed from the app takes its entries back off. A change of
// address (another screen, the cards) is the router's, not ours, and is left
// alone.

export interface HistoryLike {
  readonly state: unknown
  pushState(data: unknown, unused: string): void
  replaceState(data: unknown, unused: string): void
  go(delta: number): void
}

interface Mark { hmStack?: string; hmDepth?: number }

export class BackStack {
  /// Entries of ours above the base entry.
  pushed = 0
  private skip = 0
  private readonly id = Math.random().toString(36).slice(2)
  private hash: string

  constructor(private readonly history: HistoryLike, private readonly where: () => string) {
    this.hash = where()
  }

  private depthOf(state: unknown): number {
    const mark = (state || {}) as Mark
    return mark.hmStack === this.id && typeof mark.hmDepth === 'number' ? mark.hmDepth : 0
  }

  /// After a render: how many layers are open now.
  sync(depth: number): void {
    // Somewhere else in the meantime (another screen, and back by the app's
    // own link rather than Back): this entry is the base from here on.
    // (Not while our own step back is still on its way.)
    if (this.skip === 0 && (this.where() !== this.hash || this.depthOf(this.history.state) !== this.pushed)) {
      // Replacing an object URL (for example closing a file conversation)
      // can retain our old depth marker. Those entries belong to the old
      // address: stepping back through them would restore the closed object.
      if (this.where() !== this.hash && this.depthOf(this.history.state) > 0) {
        const { hmStack: _stack, hmDepth: _depth, ...rest } = (this.history.state || {}) as Mark
        this.history.replaceState(rest, '')
      }
      this.hash = this.where()
      this.pushed = this.depthOf(this.history.state)
    }
    if (depth > this.pushed) {
      for (let d = this.pushed + 1; d <= depth; d += 1) this.history.pushState({ hmStack: this.id, hmDepth: d }, '')
      this.pushed = depth
    } else if (depth < this.pushed) {
      const n = this.pushed - depth
      this.pushed = depth
      this.skip += 1
      this.history.go(-n)
    }
  }

  /// Back (or Forward) was pressed: how many of the open layers to close.
  popped(state: unknown): number {
    if (this.skip > 0) { this.skip -= 1; return 0 }
    if (this.where() !== this.hash) return 0
    const now = this.depthOf(state)
    if (now >= this.pushed) return 0
    const n = this.pushed - now
    this.pushed = now
    return n
  }
}

/// The list's layers, lowest first, each open or not and how to close it.
export function useBackStack(layers: Array<[boolean, () => void]>): void {
  const stack = useRef<BackStack | null>(null)
  if (!stack.current && typeof window !== 'undefined') stack.current = new BackStack(window.history, () => window.location.hash)
  const latest = useRef(layers)
  latest.current = layers
  const depth = layers.filter(([open]) => open).length
  useEffect(() => { stack.current?.sync(depth) }, [depth])
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      let n = stack.current?.popped(e.state) ?? 0
      const open = latest.current.filter(([isOpen]) => isOpen)
      for (let i = open.length - 1; i >= 0 && n > 0; i -= 1, n -= 1) open[i][1]()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
}
