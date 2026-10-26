import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { AppViewControls } from './AppViewControls'
import type {Column, Row} from '../utils/harness'
afterEach(()=>vi.unstubAllGlobals())
const columns=[{id:'state',name:'状態',type:'select' as const,options:['未着手','完了']}]
const view={id:'v',name:'All',type:'table' as const}
function setup(save=vi.fn().mockResolvedValue(undefined),onAdjust?:()=>void,columnsOverride:Column[]=columns,relationEntities:Array<{key:string;table:{columns:Column[]};rows:Row[]}> = []){
  vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
  let tree:ReturnType<typeof create>
  act(()=>{tree=create(<AppViewControls view={view} columns={columnsOverride} relationEntities={relationEntities} canEdit save={save} onAdjust={onAdjust}/> )})
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

test('relation filters search target labels and persist the stable linked record ID',async()=>{
 vi.stubGlobal('window',{innerWidth:1280,innerHeight:800,addEventListener:vi.fn(),removeEventListener:vi.fn()});
 const save=vi.fn().mockResolvedValue(undefined),relationColumns=[{id:'watchers',name:'Watchers',type:'relation' as const,targetEntity:'customers',multiple:true}];
 const relationEntities=[{key:'customers',table:{columns:[{id:'name',name:'Name',type:'text' as const}]},rows:[{id:'customer_1',values:{name:'Acme'},updatedAt:'2026-10-18T00:00:00Z'},{id:'customer_2',values:{name:'Beacon'},updatedAt:'2026-10-18T00:00:00Z'}]}];
 const ui=setup(save,undefined,relationColumns,relationEntities);ui.click('フィルター');ui.click('フィルターを調整');ui.click('条件を追加');
 act(()=>ui.tree.root.findByProps({'aria-label':'条件1の演算子'}).props.onChange({target:{value:'eq'}}));
 expect(ui.tree.root.findByProps({'aria-label':'条件1の演算子'}).findAllByType('option').map(option=>option.props.children)).toContain('を含む');
 act(()=>ui.tree.root.findByProps({'aria-label':'Watchers'}).props.onClick());
 const search=ui.tree.root.findByProps({'aria-label':'Watchersを検索'});act(()=>search.props.onChange({target:{value:'Acme'}}));
 const acme=ui.tree.root.findAllByProps({role:'option'}).find(option=>option.findAllByType('span').some(span=>span.children.includes('Acme')))!;act(()=>acme.props.onClick());
 await act(async()=>{ui.tree.root.findAllByType('button').find(button=>button.children.includes('保存'))!.props.onClick();await Promise.resolve()});
 expect(save).toHaveBeenCalledWith({filters:[{column:'watchers',op:'eq',value:'customer_1'}],where:{}});
 act(()=>ui.tree.update(<AppViewControls view={{...view,filters:[{column:'watchers',op:'eq',value:'customer_1'}]}} columns={relationColumns} relationEntities={relationEntities} canEdit save={save}/>));
 ui.click('フィルター');expect(ui.tree.root.findAllByType('p').map(item=>item.children.join('')).join(' ')).toContain('Watchers を含む Acme');expect(ui.tree.root.findAllByType('p').map(item=>item.children.join('')).join(' ')).not.toContain('customer_1');
 act(()=>ui.tree.unmount())
})

 test('shared filter adjustment opens its conversation without saving and keeps direct editing available',()=>{
 const onAdjust=vi.fn();const ui=setup(undefined,onAdjust)
 ui.click('フィルター');ui.click('フィルターを調整')
 expect(onAdjust).toHaveBeenCalledTimes(1)
 expect(ui.tree.root.findAllByProps({role:'dialog'})).toHaveLength(0)
 expect(ui.save).not.toHaveBeenCalled()
 ui.click('フィルター');ui.click('条件を直接編集');ui.click('条件を追加')
 expect(ui.tree.root.findByProps({'aria-label':'条件1の値'})).toBeDefined()
 expect(onAdjust).toHaveBeenCalledTimes(1)
 act(()=>ui.tree.unmount())
 })

test('group adjustment uses the same conversation route and retains direct editing',()=>{
 const adjust=vi.fn();const ui=setup(undefined,adjust)
 ui.click('グループ化');ui.click('グループ化を調整')
 expect(adjust).toHaveBeenCalledWith('group');expect(ui.save).not.toHaveBeenCalled()
 ui.click('グループ化');ui.click('グループを直接編集')
 expect(ui.tree.root.findByProps({'aria-label':'グループ化するフィールド'})).toBeDefined()
 act(()=>ui.tree.unmount())
})
