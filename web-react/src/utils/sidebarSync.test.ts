import { describe, it, expect } from 'vitest'
import { SidebarSync, SidebarEditQueue, reorderExisting, reorderIncludingNew } from './sidebarSync'

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

describe('versioned sidebar changes', () => {
  it('replays edits made before the first read, and never overwrites a concurrent device', async () => {
    let data: L = {starred:['b:kitchen']}, version = 1
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const displayed: L[] = []
    const q = new SidebarEditQueue<L>({starred:[]}, async () => { await paused; return {sidebar:data,version:String(version)} },
      async (sidebar, expected) => {
        if (expected !== String(version)) return {conflict:true,snapshot:{sidebar:data,version:String(version)}}
        data=sidebar;version++;return {conflict:false,snapshot:{sidebar:data,version:String(version)}}
      }, next => displayed.push(next), () => { throw new Error('unexpected failure') })
    void q.retry()
    q.change(star('b:front'))
    release()
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(data.starred).toEqual(['b:kitchen','b:front'])
    expect(displayed.at(-1)?.starred).toEqual(['b:kitchen','b:front'])
    data=star('b:other')(data);version++
    q.change(star('b:last'))
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(data.starred).toEqual(['b:kitchen','b:front','b:other','b:last'])
  })

  it('serializes same-device saves and keeps edits made while a write is pending', async () => {
    let data:L={starred:[]},version=0, active=0,maxActive=0,release!:()=>void
    const paused=new Promise<void>(resolve=>{release=resolve})
    const q=new SidebarEditQueue<L>({starred:[]},async()=>({sidebar:data,version:String(version)}),
      async(sidebar,expected)=>{
        active++;maxActive=Math.max(maxActive,active)
        if(version===0)await paused
        if(expected!==String(version)){active--;return {conflict:true,snapshot:{sidebar:data,version:String(version)}}}
        data=sidebar;version++;active--;return {conflict:false,snapshot:{sidebar:data,version:String(version)}}
      },()=>{},()=>{throw new Error('unexpected failure')})
    await q.retry()
    q.change(star('b:first'))
    q.change(star('b:second'))
    release()
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(maxActive).toBe(1)
    expect(data.starred).toEqual(['b:first','b:second'])
  })

  it('does not overwrite unseen server data when initial reading fails', async () => {
    let reads=0,writes=0,failures=0
    const q=new SidebarEditQueue<L>({starred:[]},async()=>{if(!reads++)throw Error('offline');return {sidebar:{starred:['b:kitchen']},version:'one'}},
      async(sidebar)=>{writes++;expect(sidebar.starred).toEqual(['b:kitchen','b:front']);return {conflict:false,snapshot:{sidebar,version:'two'}}},()=>{},()=>{failures++})
    await q.retry()
    expect(failures).toBe(1)
    expect(writes).toBe(0)
    q.change(star('b:front'))
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(writes).toBe(1)
  })

  it('keeps newly added entries and does not resurrect removed stars when reordering', () => {
    expect(reorderExisting(['a','c','remote'],['b','c','a'])).toEqual(['c','a','remote'])
    expect(reorderIncludingNew(['remote','a'],['b','a'])).toEqual(['b','a','remote'])
  })

  it('does not automatically replay a write whose response was lost', async () => {
    let data:L={starred:[]},version=0,writes=0,uncertain=false
    const q=new SidebarEditQueue<L>({starred:[]},async()=>({sidebar:data,version:String(version)}),
      async(sidebar)=>{writes++;data=sidebar;version++;throw new Error('response lost')},()=>{},value=>{uncertain=value})
    await q.retry()
    q.change(star('b:first'))
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(uncertain).toBe(true)
    data=star('b:other')(data);version++
    await q.retry()
    q.change(star('b:later'))
    expect(writes).toBe(1)
    expect(data.starred).toEqual(['b:first','b:other'])
    expect(q.adopt({sidebar:data,version:String(version)})).toBe(true)
    // The user expressly chose the server state. No rejected edit is sent.
    expect(writes).toBe(1)
  })

  it('finishes already requested writes after its component is detached', async () => {
    let data:L={starred:[]},release!:()=>void,draws=0
    const paused=new Promise<void>(resolve=>{release=resolve})
    const q=new SidebarEditQueue<L>({starred:[]},async()=>{await paused;return {sidebar:data,version:null}},
      async(sidebar)=>{data=sidebar;return {conflict:false,snapshot:{sidebar,version:'saved'}}},()=>{draws++},()=>{})
    void q.retry()
    q.change(star('b:front'))
    q.dispose()
    const before=draws
    release()
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(data.starred).toEqual(['b:front'])
    expect(draws).toBe(before)
  })
})
