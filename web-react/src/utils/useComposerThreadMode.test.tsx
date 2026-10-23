import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {useComposerThreadMode} from './useComposerThreadMode'
test('only the current composer intent opens a successfully delivered thread, once',()=>{
 const open=vi.fn();let mode!:ReturnType<typeof useComposerThreadMode<string>>,tree!:ReturnType<typeof create>
 function Probe({scope}:{scope:string}){mode=useComposerThreadMode(scope,open);return null}
 act(()=>{tree=create(<Probe scope="org:a"/>)})
 expect(mode.capture()).toBeUndefined()
 act(()=>mode.toggle());const delivered=mode.capture()!
 expect(mode.enabled).toBe(true)
 act(()=>delivered('root'));expect(open).toHaveBeenCalledExactlyOnceWith('root');expect(mode.enabled).toBe(false)
 act(()=>delivered('duplicate'));expect(open).toHaveBeenCalledOnce()
 act(()=>mode.toggle());const stale=mode.capture()!
 act(()=>tree.update(<Probe scope="org:b"/>));act(()=>stale('wrong-room'));expect(open).toHaveBeenCalledOnce();expect(mode.enabled).toBe(false)
 act(()=>tree.update(<Probe scope="org:a"/>));act(()=>mode.toggle());act(()=>stale('returned-room'));expect(open).toHaveBeenCalledOnce()
 const cancelled=mode.capture()!;act(()=>mode.toggle());act(()=>mode.toggle());act(()=>cancelled('old-mode'));expect(open).toHaveBeenCalledOnce()
 const unmounted=mode.capture()!;act(()=>tree.unmount());act(()=>unmounted('late'));expect(open).toHaveBeenCalledOnce()
})
test('a new session or selected thread invalidates pending navigation even in the same room',()=>{
 const open=vi.fn();let mode!:ReturnType<typeof useComposerThreadMode<string>>,tree!:ReturnType<typeof create>
 function Probe({scope}:{scope:object}){mode=useComposerThreadMode(scope,open);return null}
 act(()=>{tree=create(<Probe scope={{room:'a',session:1,thread:null}}/>)})
 act(()=>mode.toggle());const beforeSession=mode.capture()!
 act(()=>tree.update(<Probe scope={{room:'a',session:2,thread:null}}/>))
 act(()=>beforeSession('old-session'));expect(open).not.toHaveBeenCalled()
 act(()=>mode.toggle());const beforeThread=mode.capture()!
 act(()=>tree.update(<Probe scope={{room:'a',session:2,thread:'other'}}/>))
 act(()=>beforeThread('late-root'));expect(open).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})
