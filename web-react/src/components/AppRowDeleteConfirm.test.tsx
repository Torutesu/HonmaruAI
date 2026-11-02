import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppRowDeleteConfirm} from './AppRowDeleteConfirm'
import {HarnessApiError} from '../utils/harness'
vi.mock('./Dialog',()=>({Dialog:({children,footer,onClose,title,lede}:any)=><div role="dialog" aria-label={title}><p>{lede}</p><button onClick={onClose}>close</button>{children}{footer}</div>}))
vi.mock('../utils/i18n',()=>({useT:()=>(text:string)=>text}))
vi.mock('../utils/locale',()=>({getLocale:()=> 'en',primary:(value:string)=>value}))
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})

test('cancel and dismiss do not delete; the target identity is visible',()=>{
 const onDelete=vi.fn(),onClose=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRowDeleteConfirm label="Alpha" rowId="row-a" onDelete={onDelete} onDeleted={vi.fn()} onClose={onClose} onUncertain={vi.fn()}/>)})
 expect(JSON.stringify(tree!.toJSON())).toContain('Alpha');expect(JSON.stringify(tree!.toJSON())).toContain('row-a')
 act(()=>tree!.root.findAllByType('button').find(button=>button.children.includes('Cancel'))!.props.onClick());expect(onClose).toHaveBeenCalledOnce();expect(onDelete).not.toHaveBeenCalled();act(()=>tree!.unmount())
})
test('one confirmation dispatches once and closes only after acknowledgement',async()=>{
 let finish!:()=>void;const onDelete=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve})),onClose=vi.fn(),onDeleted=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRowDeleteConfirm label="Alpha" rowId="row-a" onDelete={onDelete} onDeleted={onDeleted} onClose={onClose} onUncertain={vi.fn()}/>)})
 const submit=()=>tree!.root.findAllByType('button').find(button=>button.props.className==='dlg-btn danger')!
 act(()=>{submit().props.onClick();submit().props.onClick()});expect(onDelete).toHaveBeenCalledOnce();expect(submit().props.disabled).toBe(true)
 act(()=>tree!.root.findAllByType('button').find(button=>button.children.includes('close'))!.props.onClick());expect(onClose).not.toHaveBeenCalled();expect(onDeleted).not.toHaveBeenCalled()
 await act(async()=>{finish();await Promise.resolve()});expect(onDeleted).toHaveBeenCalledOnce();act(()=>tree!.unmount())
})
test.each([[new HarnessApiError('Record changed.',409),'error response was received'],[new TypeError('network failed'),'original request may finish']] as const)('failure remains visible and cannot be blindly repeated: %s',async (error,expected)=>{
 const onDelete=vi.fn().mockRejectedValue(error),onDeleted=vi.fn(),onClose=vi.fn();let tree:ReturnType<typeof create>
 const onUncertain=vi.fn();act(()=>{tree=create(<AppRowDeleteConfirm label="Alpha" rowId="row-a" onDelete={onDelete} onDeleted={onDeleted} onClose={onClose} onUncertain={onUncertain}/>)})
 const submit=()=>tree!.root.findAllByType('button').find(button=>button.props.className==='dlg-btn danger')!
 await act(async()=>{submit().props.onClick();await Promise.resolve()});expect(tree!.root.findByProps({role:'alert'}).children.join('')).toContain(expected);expect(submit().props.disabled).toBe(true);act(()=>submit().props.onClick());expect(onDelete).toHaveBeenCalledOnce();expect(onUncertain).toHaveBeenCalledOnce();expect(onDeleted).not.toHaveBeenCalled();act(()=>tree!.unmount())
})
test('a late result after unmount does not update a new screen',async()=>{
 let finish!:()=>void;const onDelete=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve})),onDeleted=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRowDeleteConfirm label="Alpha" rowId="row-a" onDelete={onDelete} onDeleted={onDeleted} onClose={vi.fn()} onUncertain={vi.fn()}/>)})
 act(()=>tree!.root.findAllByType('button').find(button=>button.props.className==='dlg-btn danger')!.props.onClick());act(()=>tree!.unmount());await act(async()=>{finish();await Promise.resolve()});expect(onDeleted).not.toHaveBeenCalled()
})
test.each(['resolve','reject'])('a timed-out delete remains uncertain after a late %s',async outcome=>{
 vi.useFakeTimers();let settle!:(failure:boolean)=>void
 const onDelete=vi.fn(()=>new Promise<void>((resolve,reject)=>{settle=failure=>failure?reject(new Error('late failure')):resolve()})),onDeleted=vi.fn(),onUncertain=vi.fn(),onClose=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRowDeleteConfirm label="Alpha" rowId="row-a" onDelete={onDelete} onDeleted={onDeleted} onClose={onClose} onUncertain={onUncertain}/>)})
 const confirm=()=>tree!.root.findAllByType('button').find(button=>button.props.className==='dlg-btn danger')!
 act(()=>confirm().props.onClick());await act(async()=>{await vi.advanceTimersByTimeAsync(15_000)})
 expect(onUncertain).toHaveBeenCalledOnce();expect(onDeleted).not.toHaveBeenCalled();expect(confirm().props.disabled).toBe(true);expect(tree!.root.findByProps({role:'alert'}).children.join('')).toContain('original request may finish')
 await act(async()=>{settle(outcome==='reject');await Promise.resolve()});expect(onUncertain).toHaveBeenCalledOnce();expect(onDeleted).not.toHaveBeenCalled();act(()=>confirm().props.onClick());expect(onDelete).toHaveBeenCalledOnce();act(()=>tree!.unmount())
})
