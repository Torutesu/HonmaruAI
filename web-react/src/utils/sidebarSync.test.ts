import { afterEach, describe, it, expect } from 'vitest'
import { SidebarSync, SidebarEditQueue, bindSidebarSession, trackSidebarQueue, hasPendingSidebarQueues, clearSidebarSessionQueues, clearSidebarWorkspaceQueues, currentSidebarSession, retainSidebarQueue, takeSidebarQueue, reorderExisting, reorderIncludingNew } from './sidebarSync'
import type { SidebarSnapshot, SidebarWrite } from './sidebarSync'

type L = { starred: string[] }
afterEach(() => { clearSidebarSessionQueues() })
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

  it('restores a pending edit when returning to the same account and workspace after an offline read', async () => {
    let rejectRead!: (error: Error) => void
    let writes=0, warnings=0, reads=0
    const pendingRead=new Promise<{sidebar:L;version:string|null}>((_,reject)=>{rejectRead=reject})
    const q=new SidebarEditQueue<L>({starred:[]},()=>reads++ ? Promise.resolve({sidebar:{starred:['b:kitchen']},version:'v1'}) : pendingRead,
      async sidebar=>{writes++;expect(sidebar.starred).toEqual(['b:kitchen','b:front']);return {conflict:false,snapshot:{sidebar,version:'saved'}}},()=>{},()=>{warnings++})
    void q.retry()
    q.change(star('b:front'))
    retainSidebarQueue('server/session/user/workspace-a',q)
    rejectRead(new Error('offline'))
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(writes).toBe(0)
    expect(warnings).toBe(0)
    // A different account or workspace cannot receive these operations.
    expect(takeSidebarQueue('server/session/user/workspace-b')).toBeNull()
    expect(takeSidebarQueue('server/other/user/workspace-a')).toBeNull()
    const restored=takeSidebarQueue<L>('server/session/user/workspace-a')!
    expect(restored).toBe(q)
    restored.attach(()=>{},()=>{warnings++})
    await restored.retry()
    expect(writes).toBe(1)
    expect(restored.hasPending()).toBe(false)
  })

  it('preserves an uncertain write across a workspace switch without automatically replaying it', async () => {
    let writes=0, alerted=false
    const q=new SidebarEditQueue<L>({starred:[]},async()=>({sidebar:{starred:[]},version:'v1'}),
      async()=>{writes++;throw new Error('response lost')},()=>{},()=>{})
    await q.retry()
    q.change(star('b:front'))
    retainSidebarQueue('server/session/user/uncertain',q)
    await new Promise(resolve=>setTimeout(resolve,0))
    const restored=takeSidebarQueue<L>('server/session/user/uncertain')!
    restored.attach(()=>{},uncertain=>{alerted=uncertain})
    await restored.retry()
    expect(alerted).toBe(true)
    expect(writes).toBe(1)
    expect(restored.hasPending()).toBe(true)
  })

  it('releases a detached queue after its pending write completes', async () => {
    let release!:()=>void
    const waiting=new Promise<void>(resolve=>{release=resolve})
    const statuses:boolean[]=[]
    const q=new SidebarEditQueue<L>({starred:[]},async()=>({sidebar:{starred:[]},version:'v1'}),
      async sidebar=>{await waiting;return {conflict:false,snapshot:{sidebar,version:'v2'}}},
      (_layout,_ready,pending)=>statuses.push(pending),()=>{})
    await q.retry()
    q.change(star('b:front'))
    expect(statuses.at(-1)).toBe(true)
    retainSidebarQueue('server/session/user/drained',q)
    release()
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(takeSidebarQueue('server/session/user/drained')).toBeNull()
  })

  it('aborts a detached initial read when no user edits need recovery', async () => {
    let aborted=false
    const q=new SidebarEditQueue<L>({starred:[]},()=>new Promise(()=>{}),async sidebar=>({conflict:false,snapshot:{sidebar,version:'v'}}),()=>{},()=>{},()=>{aborted=true})
    trackSidebarQueue(q)
    void q.retry()
    retainSidebarQueue('server/secret/user/empty',q)
    expect(aborted).toBe(true)
    expect(q.isCancelled()).toBe(true)
    expect(takeSidebarQueue('server/secret/user/empty')).toBeNull()
  })

  it('cancels retained and active session queues without reusing a late read', async () => {
    let release!: (snapshot:{sidebar:L;version:string})=>void
    let writes=0,abort=0,shown=0
    const waiting=new Promise<{sidebar:L;version:string}>(resolve=>{release=resolve})
    const q=new SidebarEditQueue<L>({starred:[]},()=>waiting,
      async sidebar=>{writes++;return {conflict:false,snapshot:{sidebar,version:'saved'}}},()=>{shown++},()=>{},()=>{abort++})
    trackSidebarQueue(q)
    void q.retry()
    q.change(star('b:front'))
    retainSidebarQueue('server/secret/user/workspace',q)
    expect(hasPendingSidebarQueues()).toBe(true)
    expect(clearSidebarSessionQueues()).toBe(true)
    expect(abort).toBe(1)
    expect(q.hasPending()).toBe(false)
    expect(takeSidebarQueue('server/secret/user/workspace')).toBeNull()
    const before=shown
    release({sidebar:{starred:['b:kitchen']},version:'v1'})
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(writes).toBe(0)
    expect(shown).toBe(before)
    retainSidebarQueue('server/secret/user/workspace',q)
    expect(takeSidebarQueue('server/secret/user/workspace')).toBeNull()
  })

  it('aborts an in-flight write and ignores its late success after session clearing', async () => {
    let resolveWrite!: (value:{conflict:false;snapshot:{sidebar:L;version:string}})=>void
    let aborted=false,shown=0
    const waiting=new Promise<{conflict:false;snapshot:{sidebar:L;version:string}}>(resolve=>{resolveWrite=resolve})
    const q=new SidebarEditQueue<L>({starred:[]},async()=>({sidebar:{starred:[]},version:'v1'}),
      ()=>waiting,()=>{shown++},()=>{},()=>{aborted=true})
    trackSidebarQueue(q)
    await q.retry()
    q.change(star('b:front'))
    expect(clearSidebarSessionQueues()).toBe(true)
    const before=shown
    resolveWrite({conflict:false,snapshot:{sidebar:{starred:['b:front']},version:'v2'}})
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(aborted).toBe(true)
    expect(shown).toBe(before)
    expect(q.hasPending()).toBe(false)
  })

  it('binds queues to the server, user and exact session even across a component remount', () => {
    let aborted=0
    expect(bindSidebarSession('https://one.invalid','old-token','reader')).toBe(false)
    const q=new SidebarEditQueue<L>({starred:[]},()=>new Promise(()=>{}),async sidebar=>({conflict:false,snapshot:{sidebar,version:'saved'}}),()=>{},()=>{},()=>{aborted++})
    trackSidebarQueue(q);q.change(star('b:front'));retainSidebarQueue('old',q)
    expect(bindSidebarSession('https://one.invalid','old-token','reader')).toBe(false)
    expect(q.hasPending()).toBe(true)
    expect(bindSidebarSession('https://one.invalid','new-token','reader')).toBe(true)
    expect(aborted).toBe(1)
    expect(takeSidebarQueue('old')).toBeNull()
  })

  it('access loss cancels only the affected workspace queue', () => {
    const aborted: string[] = []
    const make = (key: string) => {
      const q = new SidebarEditQueue<L>({starred:[]},()=>new Promise(()=>{}),async sidebar=>({conflict:false,snapshot:{sidebar,version:'saved'}}),()=>{},()=>{},()=>{aborted.push(key)})
      trackSidebarQueue(q,key)
      q.change(star(`b:${key}`))
      return q
    }
    const current=make('workspace-a'), other=make('workspace-b')
    retainSidebarQueue('workspace-b',other)
    expect(clearSidebarWorkspaceQueues('workspace-a')).toBe(true)
    expect(aborted).toEqual(['workspace-a'])
    expect(current.hasPending()).toBe(false)
    expect(other.hasPending()).toBe(true)
    expect(takeSidebarQueue('workspace-b')).toBe(other)
    expect(hasPendingSidebarQueues()).toBe(true)
  })

  it('does not dispatch a pending edit after storage changes but before the storage event', async () => {
    const values=new Map([['sessionToken','old'],['userId','alice'],['host','server.invalid']])
    const storage={getItem:(key:string)=>values.get(key)||null}
    const current=()=>currentSidebarSession(storage,'https://server.invalid','old','alice')
    let finishRead!: (snapshot:SidebarSnapshot<L>)=>void
    let writes=0,shown=0
    const waiting=new Promise<SidebarSnapshot<L>>(resolve=>{finishRead=resolve})
    const q=new SidebarEditQueue<L>({starred:[]},()=>waiting,async sidebar=>{writes++;return {conflict:false,snapshot:{sidebar,version:'saved'}}},()=>{shown++},()=>{},()=>{},undefined,current)
    q.change(star('b:front'))
    values.set('sessionToken','new')
    const before=shown
    finishRead({sidebar:{starred:['b:old']},version:'v1'})
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(writes).toBe(0)
    expect(shown).toBe(before)
    expect(q.hasPending()).toBe(true)
  })

  it('keeps an already dispatched write uncertain when storage changes before its answer', async () => {
    const values=new Map([['sessionToken','old'],['userId','alice'],['host','server.invalid']])
    const storage={getItem:(key:string)=>values.get(key)||null}
    const current=()=>currentSidebarSession(storage,'https://server.invalid','old','alice')
    let finish!: (write:SidebarWrite<L>)=>void
    let warned=false,shown=0
    const waiting=new Promise<SidebarWrite<L>>(resolve=>{finish=resolve})
    const q=new SidebarEditQueue<L>({starred:[]},async()=>({sidebar:{starred:[]},version:'v1'}),()=>waiting,()=>{shown++},uncertain=>{warned=uncertain},()=>{},undefined,current)
    await q.retry()
    q.change(star('b:front'))
    values.set('sessionToken','new')
    const before=shown
    finish({conflict:false,snapshot:{sidebar:{starred:['b:front']},version:'v2'}})
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(shown).toBe(before)
    expect(warned).toBe(true)
    expect(q.hasPending()).toBe(true)
  })

  it('checks server, user and session and fails closed when storage is unavailable', () => {
    const values=new Map([['sessionToken','old'],['userId','alice'],['host','server.invalid']])
    const storage={getItem:(key:string)=>values.get(key)||null}
    expect(currentSidebarSession(storage,'https://server.invalid','old','alice')).toBe(true)
    expect(currentSidebarSession(storage,'https://other.invalid','old','alice')).toBe(false)
    expect(currentSidebarSession(storage,'https://server.invalid','new','alice')).toBe(false)
    expect(currentSidebarSession(storage,'https://server.invalid','old','bob')).toBe(false)
    expect(currentSidebarSession({getItem:()=>{throw new Error('denied')}},'https://server.invalid','old','alice')).toBe(false)
    values.delete('host')
    expect(currentSidebarSession(storage,'https://server.invalid','old','alice')).toBe(false)
    expect(currentSidebarSession(storage,`https://${import.meta.env.VITE_API_HOST || 'localhost:8787'}`,'old','alice')).toBe(true)
  })
})
