import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {DlpDialog} from './DlpDialog'
import {ReauthDialog} from './ReauthDialog'
import {askAboutData,askToConfirm,askingAboutData} from '../utils/authGuard'
import {sessionFence} from '../utils/sessionFence'

vi.mock('../utils/i18n',()=>({useT:()=>((s:string)=>s)}))
vi.mock('./Dialog',()=>({Dialog:({children,footer}:{children:React.ReactNode;footer:React.ReactNode})=><div>{children}{footer}</div>}))

afterEach(()=>{vi.unstubAllGlobals()})
function setup(){
 const values=new Map([['sessionToken','old'],['userId','alice'],['host','api.test']])
 const storage={getItem:(key:string)=>values.get(key)||null}
 const w=Object.assign(new EventTarget(),{location:{href:'https://app.test/',protocol:'https:'}})
 vi.stubGlobal('window',w);vi.stubGlobal('localStorage',storage)
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({method:'password'}),{status:200}))
 vi.stubGlobal('fetch',fetcher)
 return {values,w,fetcher}
}

test('unmounting a DLP dialog refuses and releases its waiting promise',async()=>{
 setup();const fence=sessionFence('https://api.test/save','old')
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<DlpDialog/>)})
 let pending!:Promise<boolean>
 await act(async()=>{pending=askAboutData(['private'],[],fence)})
 expect(askingAboutData()).toBe(true)
 act(()=>tree.unmount())
 expect(await pending).toBe(false)
 expect(askingAboutData()).toBe(false)
 fence.release()
})

test('unmounting a reauthentication dialog refuses and releases its waiting promise',async()=>{
 const e=setup(),fence=sessionFence('https://api.test/save','old')
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ReauthDialog/>)})
 let pending!:Promise<boolean>,detail:unknown
 e.w.addEventListener('honmaru:reauth',event=>{detail=(event as CustomEvent).detail})
 await act(async()=>{pending=askToConfirm('https://api.test',fence);await Promise.resolve();await Promise.resolve()})
 expect(Object.keys(detail as object)).not.toContain('token')
 act(()=>tree.unmount())
 expect(await pending).toBe(false)
 fence.release()
})

test('a changed account closes a pending DLP prompt without approving it',async()=>{
 const e=setup(),fence=sessionFence('https://api.test/save','old')
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<DlpDialog/>)})
 let pending!:Promise<boolean>
 await act(async()=>{pending=askAboutData(['private'],[],fence)})
 e.values.set('sessionToken','new');e.values.set('userId','bob')
 await act(async()=>{e.w.dispatchEvent(new Event('storage'))})
 expect(await pending).toBe(false)
 expect(tree.toJSON()).toBeNull()
 act(()=>tree.unmount());fence.release()
})

test('a changed account cannot send a code or password through an old reauthentication prompt',async()=>{
 const e=setup(),fence=sessionFence('https://api.test/save','old')
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<ReauthDialog/>)})
 let pending!:Promise<boolean>
 await act(async()=>{pending=askToConfirm('https://api.test',fence);await Promise.resolve();await Promise.resolve();await Promise.resolve()})
 const password=tree.root.findByProps({'aria-label':'Password'})
 act(()=>password.props.onChange({target:{value:'not-a-real-password'}}))
 e.values.set('sessionToken','new');e.values.set('userId','bob')
 await act(async()=>tree.root.findByProps({'data-reauth-confirm':true}).props.onClick())
 expect(await pending).toBe(false)
 expect(e.fetcher).toHaveBeenCalledTimes(1)
 act(()=>tree.unmount());fence.release()
})
