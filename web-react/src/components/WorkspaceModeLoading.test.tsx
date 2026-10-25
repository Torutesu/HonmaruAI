import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {WorkspaceModeLoading} from './WorkspaceModeLoading'
vi.mock('../utils/i18n',()=>({useT:()=>((text:string)=>text)}))
test('loading offers no accidental mode controls; errors offer retry and explicit Simple',()=>{
 const retry=vi.fn(),simple=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<WorkspaceModeLoading error="" onRetry={retry} onSimple={simple}/>)})
 expect(tree!.root.findByProps({role:'status'})).toBeTruthy();expect(tree!.root.findAllByType('button')).toHaveLength(0)
 act(()=>{tree!.update(<WorkspaceModeLoading error="Failed" onRetry={retry} onSimple={simple}/>)})
 expect(tree!.root.findByProps({role:'alert'})).toBeTruthy()
 const buttons=tree!.root.findAllByType('button');act(()=>buttons[0].props.onClick());act(()=>buttons[1].props.onClick())
 expect(retry).toHaveBeenCalledTimes(1);expect(simple).toHaveBeenCalledTimes(1);act(()=>tree!.unmount())
})
