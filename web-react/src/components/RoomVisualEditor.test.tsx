import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {RoomVisualEditor} from './RoomVisualEditor'
import {RoomColorPicker} from './RoomColorPicker'
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
const api={httpBase:'https://relay.test',orgId:'org',sessionToken:'token'}
const base={api,channel:'b:first',version:1,color:'teal' as const,onColor:vi.fn(),disabled:false,dirty:false}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
test('a timed-out upload unlocks dismissal but requires readback before retry',async()=>{
 vi.useFakeTimers();let finish!:(value:any)=>void
 const fetcher=vi.fn().mockImplementation(()=>new Promise(resolve=>{finish=resolve}));vi.stubGlobal('fetch',fetcher)
 const changed=vi.fn(),busy=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<RoomVisualEditor {...base} onChanged={changed} onBusy={busy}/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{files:[new File(['png'],'test.png',{type:'image/png'})],value:'test'}}))
 expect(busy).toHaveBeenLastCalledWith(true)
 await act(async()=>{await vi.advanceTimersByTimeAsync(15000)})
 expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);expect(busy).toHaveBeenLastCalledWith(false)
 expect(tree.root.findByType(RoomColorPicker).props.visualDisabled).toBe(true)
 await act(async()=>finish({ok:true}));expect(changed).not.toHaveBeenCalled()
 act(()=>tree.root.findAllByType('button').find(n=>n.children.includes('Reload latest settings'))!.props.onClick())
 expect(changed).toHaveBeenCalledOnce();act(()=>tree.unmount())
})
test('an old upload cannot trigger callbacks after the editor unmounts',async()=>{
 let finish!:(value:any)=>void
 vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>new Promise(resolve=>{finish=resolve})))
 const changed=vi.fn(),busy=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<RoomVisualEditor {...base} onChanged={changed} onBusy={busy}/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{files:[new File(['png'],'test.png',{type:'image/png'})],value:'test'}}))
 act(()=>tree.unmount());expect(busy).toHaveBeenLastCalledWith(false)
 await act(async()=>finish({ok:true}));expect(changed).not.toHaveBeenCalled()
})
