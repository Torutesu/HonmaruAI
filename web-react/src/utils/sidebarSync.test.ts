import { describe, it, expect } from 'vitest'
import { SidebarSync } from './sidebarSync'

type L = { starred: string[] }
const star = (v: string) => (base: L): L => ({ starred: [...base.starred.filter((x) => x !== v), v] })
const unstar = (v: string) => (base: L): L => ({ starred: base.starred.filter((x) => x !== v) })

describe('the sidebar, against answers that come back late', () => {
  it('shows a star made before the saved layout arrives, and saves it on top of that layout', () => {
    const sync = new SidebarSync<L>()
    const made = sync.change({ starred: [] }, star('b:front'))
    expect(made.next.starred).toEqual(['b:front'])
    // Not saved yet: the empty layout it was made on is not the person's.
    expect(made.save).toBeNull()
    const loaded = sync.arrived({ starred: ['b:kitchen'] })
    // What was starred elsewhere stays; the new star is kept, not undone.
    expect(loaded.next.starred).toEqual(['b:kitchen', 'b:front'])
    expect(loaded.save?.starred).toEqual(['b:kitchen', 'b:front'])
  })

  it('replays several early changes in the order they were made', () => {
    const sync = new SidebarSync<L>()
    let shown: L = { starred: [] }
    shown = sync.change(shown, star('b:a')).next
    shown = sync.change(shown, star('b:b')).next
    shown = sync.change(shown, unstar('b:a')).next
    expect(shown.starred).toEqual(['b:b'])
    expect(sync.arrived({ starred: ['b:a', 'b:c'] }).save?.starred).toEqual(['b:c', 'b:b'])
  })

  it('saves nothing when nothing was changed before the layout arrived', () => {
    const sync = new SidebarSync<L>()
    expect(sync.arrived({ starred: ['b:kitchen'] })).toEqual({ next: { starred: ['b:kitchen'] }, save: null })
  })

  it('saves at once once the layout is in', () => {
    const sync = new SidebarSync<L>()
    sync.arrived({ starred: [] })
    expect(sync.change({ starred: [] }, star('b:front')).save?.starred).toEqual(['b:front'])
  })

  it('draws only the answer to the latest save', () => {
    const sync = new SidebarSync<L>()
    const first = sync.begin()
    const second = sync.begin()
    expect(sync.latest(first)).toBe(false)
    expect(sync.latest(second)).toBe(true)
  })

  it('still saves an early change when the saved layout cannot be read', () => {
    const sync = new SidebarSync<L>()
    const shown = sync.change({ starred: [] }, star('b:front')).next
    expect(sync.unavailable(shown)?.starred).toEqual(['b:front'])
    // And from then on, saves go straight out.
    expect(sync.change(shown, star('b:kitchen')).save?.starred).toEqual(['b:front', 'b:kitchen'])
  })

  it('ignores a read that fails after the layout already arrived', () => {
    const sync = new SidebarSync<L>()
    sync.arrived({ starred: [] })
    expect(sync.unavailable({ starred: [] })).toBeNull()
  })
})
