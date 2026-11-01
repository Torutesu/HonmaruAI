import React from 'react'
import {act, create} from 'react-test-renderer'
import {afterEach, expect, test, vi} from 'vitest'
import {SidebarEditQueue, trackSidebarQueue, clearSidebarSessionQueues, hasPendingSidebarQueues} from './utils/sidebarSync'

vi.mock('./components/Dashboard', () => ({Dashboard: ({onLogout,onAccountDeleted,onLeft}: {onLogout:()=>void;onAccountDeleted:()=>void;onLeft:()=>void}) => <div><button data-logout onClick={onLogout}>logout</button><button data-deleted onClick={onAccountDeleted}>deleted</button><button data-left onClick={onLeft}>left</button></div>}))
vi.mock('./components/ReauthDialog',()=>({ReauthDialog:()=>null}))
vi.mock('./components/DlpDialog',()=>({DlpDialog:()=>null}))
vi.mock('./screens/SharedThread',()=>({SharedThread:()=> <div>public thread</div>}))
vi.mock('./screens/PublicSkillShare',()=>({PublicSkillShare:()=> <div>public skill</div>}))
vi.mock('./screens/Welcome', () => ({Welcome: () => <div>welcome</div>}))
vi.mock('./utils/onboardingProgress', () => ({onboardingKey:()=>'',needsOnboarding:()=>false,completeOnboarding:()=>{}}))
vi.mock('./utils/githubAuth', () => ({githubWebConfig:async()=>null,beginGitHubSignIn:async()=>{},readCallback:()=>null,finishGitHubSignIn:async()=>({})}))
vi.mock('./utils/cardCache', () => ({clearCardCache:()=>{},accountOwner:()=>'',claimAccountData:()=>{},adoptAccountData:()=>{},releaseAccountData:()=>{}}))
vi.mock('./utils/emojiSearch', () => ({resetEmojiAccount:()=>{}}))
vi.mock('./utils/push', () => ({disableWebPush:async()=>{},sessionIsCurrent:()=>true}))
vi.mock('./utils/i18n', () => ({t:(s:string)=>s,adoptAccountLocale:()=>{}}))
vi.mock('./utils/locale', () => ({getLocale:()=> 'en'}))

import App from './App'

type L={starred:string[]}
function pendingQueue(workspace='org') {
  let aborted=false
  const q=new SidebarEditQueue<L>({starred:[]},()=>new Promise(()=>{}),async sidebar=>({conflict:false,snapshot:{sidebar,version:'v'}}),()=>{},()=>{},()=>{aborted=true})
  trackSidebarQueue(q,JSON.stringify(['http://synthetic.invalid','old-token','reader',workspace]))
  q.change(base=>({starred:[...base.starred,'b:front']}))
  return {q,get aborted(){return aborted}}
}

async function setup(orgs=[{id:'org'}]) {
  const values=new Map([['sessionToken','old-token'],['userId','reader'],['orgId','org'],['host','synthetic.invalid']])
  const localStorage={getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)}
  const listeners=new Map<string,Set<(e:any)=>void>>()
  const add=(type:string,fn:(e:any)=>void)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type)!.add(fn)}
  const remove=(type:string,fn:(e:any)=>void)=>listeners.get(type)?.delete(fn)
  const confirm=vi.fn(()=>true)
  vi.stubGlobal('localStorage',localStorage)
  const location={hash:'#/feed',protocol:'http:',pathname:'/',search:''}
  vi.stubGlobal('location',location)
  vi.stubGlobal('history',{replaceState:vi.fn()})
  vi.stubGlobal('navigator',{onLine:true})
  vi.stubGlobal('window',{addEventListener:add,removeEventListener:remove,confirm,location:{href:''}})
  vi.stubGlobal('document',{addEventListener:add,removeEventListener:remove,visibilityState:'visible'})
  vi.stubGlobal('fetch',vi.fn(async (url:string)=>({ok:true,status:200,json:async()=>url.endsWith('/me')?{login:'reader',orgs}:{}})))
  let tree!:ReturnType<typeof create>
  await act(async()=>{tree=create(<App/>);await Promise.resolve();await Promise.resolve();await Promise.resolve()})
  return {tree,values,confirm,location,fire:(type:string,event:any)=>{for(const fn of listeners.get(type)||[])fn(event)}}
}
afterEach(()=>{clearSidebarSessionQueues();vi.unstubAllGlobals()})

test('explicit sign out can be canceled, then discards pending edits and warns',async()=>{
  const ui=await setup(), pending=pendingQueue()
  ui.confirm.mockReturnValueOnce(false)
  await act(async()=>ui.tree.root.findByProps({'data-logout':true}).props.onClick())
  expect(hasPendingSidebarQueues()).toBe(true)
  expect(ui.values.get('sessionToken')).toBe('old-token')
  expect(pending.aborted).toBe(false)
  await act(async()=>ui.tree.root.findByProps({'data-logout':true}).props.onClick())
  expect(ui.confirm).toHaveBeenCalledTimes(2)
  expect(pending.aborted).toBe(true)
  expect(hasPendingSidebarQueues()).toBe(false)
  expect(JSON.stringify(ui.tree.toJSON())).toContain('Pending sidebar changes were discarded')
  act(()=>ui.tree.unmount())
})

test('session replacement from another tab cancels old work and warns the new session',async()=>{
  const ui=await setup(), pending=pendingQueue()
  ui.values.set('sessionToken','new-token')
  await act(async()=>{ui.fire('storage',{key:'sessionToken'});await Promise.resolve();await Promise.resolve();await Promise.resolve()})
  expect(pending.aborted).toBe(true)
  expect(hasPendingSidebarQueues()).toBe(false)
  expect(JSON.stringify(ui.tree.toJSON())).toContain('Pending sidebar changes were discarded')
  act(()=>ui.tree.unmount())
})

test('account deletion and browser unload do not silently lose pending changes',async()=>{
  const ui=await setup(), pending=pendingQueue(), event={preventDefault:vi.fn(),returnValue:'x'}
  ui.fire('beforeunload',event)
  expect(event.preventDefault).toHaveBeenCalled()
  expect(event.returnValue).toBe('')
  await act(async()=>ui.tree.root.findByProps({'data-deleted':true}).props.onClick())
  expect(ui.confirm).not.toHaveBeenCalled()
  expect(pending.aborted).toBe(true)
  expect(JSON.stringify(ui.tree.toJSON())).toContain('Pending sidebar changes were discarded')
  act(()=>ui.tree.unmount())
})

test('forced policy logout cancels pending work without offering to remain signed in',async()=>{
  const ui=await setup(),pending=pendingQueue()
  await act(async()=>ui.fire('honmaru:session-policy',{}))
  expect(ui.confirm).not.toHaveBeenCalled()
  expect(pending.aborted).toBe(true)
  expect(JSON.stringify(ui.tree.toJSON())).toContain('Pending sidebar changes were discarded')
  act(()=>ui.tree.unmount())
})

test('workspace access loss stops queued writes before leaving',async()=>{
  const ui=await setup(),pending=pendingQueue()
  await act(async()=>{ui.tree.root.findByProps({'data-left':true}).props.onClick();await Promise.resolve();await Promise.resolve()})
  expect(ui.confirm).not.toHaveBeenCalled()
  expect(pending.aborted).toBe(true)
  expect(JSON.stringify(ui.tree.toJSON())).toContain('Pending sidebar changes were discarded')
  act(()=>ui.tree.unmount())
})

test('workspace access loss preserves pending edits for another accessible workspace',async()=>{
  const ui=await setup([{id:'org'},{id:'org2'}]), current=pendingQueue(), other=pendingQueue('org2')
  await act(async()=>{ui.tree.root.findByProps({'data-left':true}).props.onClick();await Promise.resolve();await Promise.resolve()})
  expect(current.aborted).toBe(true)
  expect(other.aborted).toBe(false)
  expect(other.q.hasPending()).toBe(true)
  expect(ui.values.get('orgId')).toBe('org2')
  act(()=>ui.tree.unmount())
})

test('another tab signing out clears retained queues even on a public page',async()=>{
  const ui=await setup(),pending=pendingQueue()
  await act(async()=>{ui.location.hash='#/shared/synthetic';ui.fire('hashchange',{})})
  expect(JSON.stringify(ui.tree.toJSON())).toContain('public thread')
  const event={preventDefault:vi.fn(),returnValue:'x'}
  ui.fire('beforeunload',event)
  expect(event.preventDefault).toHaveBeenCalled()
  ui.values.delete('sessionToken')
  await act(async()=>ui.fire('storage',{key:'sessionToken'}))
  expect(pending.aborted).toBe(true)
  expect(JSON.stringify(ui.tree.toJSON())).toContain('session changed and pending sidebar edits were discarded')
  act(()=>ui.tree.unmount())
})

test('a different session found on returning from a public page clears the old queue',async()=>{
  const ui=await setup(),pending=pendingQueue()
  await act(async()=>{ui.location.hash='#/shared/synthetic';ui.fire('hashchange',{})})
  ui.values.set('sessionToken','new-token')
  await act(async()=>{ui.location.hash='#/feed';ui.fire('hashchange',{});await Promise.resolve();await Promise.resolve();await Promise.resolve()})
  expect(pending.aborted).toBe(true)
  expect(JSON.stringify(ui.tree.toJSON())).toContain('Pending sidebar changes were discarded')
  act(()=>ui.tree.unmount())
})
