import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { AppViewControls } from './AppViewControls'
afterEach(()=>vi.unstubAllGlobals())
const columns=[{id:'state',name:'状態',type:'select' as const,options:['未着手','完了']}]
const view={id:'v',name:'All',type:'table' as const}
function setup(save=vi.fn().mockResolvedValue(undefined)){
  vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
  let tree:ReturnType<typeof create>
  act(()=>{tree=create(<AppViewControls view={view} columns={columns} canEdit save={save}/> )})
  const click=(text:string)=>act(()=>tree!.root.findAllByType('button').find(b=>b.children.some(c=>c===text))!.props.onClick({currentTarget:{focus:vi.fn()}}))
  return {get tree(){return tree!},click,save}
}
test('filter editor saves selected values and preserves its draft on server rejection',async()=>{
  const save=vi.fn().mockRejectedValue(new Error('Reload before saving.'))
  const ui=setup(save)
  ui.click('フィルター');ui.click('フィルターを調整');ui.click('条件を追加')
  act(()=>ui.tree.root.findByProps({'aria-label':'条件1の値'}).props.onChange({target:{value:'完了'}}))
  await act(async()=>{ui.tree.root.findAllByType('button').find(b=>b.children.includes('保存'))!.props.onClick();await Promise.resolve()})
  expect(save).toHaveBeenCalledWith({filters:[{column:'state',op:'eq',value:'完了'}],where:{}})
  expect(ui.tree.root.findByProps({role:'alert'}).children).toContain('Reload before saving.')
  expect(ui.tree.root.findByProps({'aria-label':'条件1の値'}).props.value).toBe('完了')
  act(()=>ui.tree.unmount())
})
test('group editor can select and save a column',async()=>{
  const ui=setup();ui.click('グループ化');ui.click('グループ化を調整')
  act(()=>ui.tree.root.findByProps({'aria-label':'グループ化するフィールド'}).props.onChange({target:{value:'state'}}))
  await act(async()=>{ui.tree.root.findAllByType('button').find(b=>b.children.includes('保存'))!.props.onClick();await Promise.resolve()})
  expect(ui.save).toHaveBeenCalledWith({groupBy:'state'})
  act(()=>ui.tree.unmount())
})

test('metadata timestamp filters expose local datetime input and save UTC',async()=>{
 const ui=setup();ui.click('フィルター');ui.click('フィルターを調整');ui.click('条件を追加')
 act(()=>ui.tree.root.findByProps({'aria-label':'条件1のフィールド'}).props.onChange({target:{value:'$row.updatedAt'}}))
 const input=ui.tree.root.findByProps({'aria-label':'条件1の値'})
 expect(input.props.type).toBe('datetime-local')
 expect(ui.tree.root.findByProps({'aria-label':'条件1の演算子'}).findAllByType('option').map(n=>n.props.value)).not.toContain('contains')
 act(()=>input.props.onChange({target:{value:'2026-10-18T11:00:00'}}))
 await act(async()=>{ui.tree.root.findAllByType('button').find(b=>b.children.includes('保存'))!.props.onClick();await Promise.resolve()})
 expect(ui.save.mock.calls[0][0].filters).toEqual([{column:'$row.updatedAt',op:'eq',value:new Date('2026-10-18T11:00:00').toISOString()}])
 act(()=>ui.tree.unmount())
})
