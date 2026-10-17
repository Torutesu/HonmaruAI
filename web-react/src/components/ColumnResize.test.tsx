import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {ColumnResize} from './ColumnResize'
test('keyboard and pointer widths are bounded and cancelled drags do not save',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);let tree:ReturnType<typeof create>
 act(()=>{tree=create(<ColumnResize name="Title" width={590} save={save}/>)})
 const handle=()=>tree!.root.findByProps({role:'separator'})
 await act(async()=>{handle().props.onKeyDown({key:'ArrowRight',preventDefault:vi.fn()});await Promise.resolve()})
 expect(save).toHaveBeenLastCalledWith(600)
 act(()=>handle().props.onPointerDown({clientX:100,pointerId:1,preventDefault:vi.fn(),currentTarget:{setPointerCapture:vi.fn()}}))
 await act(async()=>{handle().props.onPointerUp({clientX:-1000});await Promise.resolve()})
 expect(save).toHaveBeenLastCalledWith(80)
 act(()=>handle().props.onPointerDown({clientX:100,pointerId:1,preventDefault:vi.fn(),currentTarget:{setPointerCapture:vi.fn()}}))
 act(()=>handle().props.onPointerCancel())
 act(()=>handle().props.onPointerUp({clientX:200}))
 expect(save).toHaveBeenCalledTimes(2)
 act(()=>tree!.unmount())
})
