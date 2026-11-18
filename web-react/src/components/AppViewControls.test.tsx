vi.mock('../utils/i18n',()=>({useT:()=> (key:string,values?:Record<string,unknown>)=>({'Filter records':'フィルター','Group records':'グループ化','Calendar time zone':'カレンダーのタイムゾーン','Enter a valid IANA time zone.':'有効なIANAタイムゾーンを入力してください。','{label} ({n} active)':'{label}（{n}件）','Edit filters':'フィルターを編集','Edit grouping':'グループ化を編集','{count} conditions (match all)':'{count}件の条件（すべて一致）','No filters':'フィルターなし','Adjust filters':'フィルターを調整','Adjust grouping':'グループ化を調整','Ask AI to suggest changes':'AIに調整案を相談','Records matching all conditions':'すべての条件に一致するレコード','Existing conditions':'既存の条件','Clear existing conditions':'既存条件を解除','Condition {n} field':'条件{n}のフィールド','Condition {n} operator':'条件{n}の演算子','Condition {n} value':'条件{n}の値','Remove condition {n}':'条件{n}を削除','equals':'と等しい','does not equal':'と等しくない','contains':'を含む','does not contain':'を含まない','is empty':'が空','is not empty':'が空ではない','Choose a value':'値を選択','Checked':'チェックあり','Unchecked':'チェックなし','Enter date and time in your device time zone (to the second).':'日時は端末のタイムゾーンで入力します（秒単位）。','Add condition':'条件を追加','No grouping':'グループ化なし','Grouping':'グループ化','Field':'フィールド','Group by field':'グループ化するフィールド','Group records with the same value.':'同じ値のレコードをまとめて表示します。','Only you can see this view. It syncs across your devices.':'自分だけに適用・端末間で同期されます。','Changes apply to everyone who uses this view.':'このビューを使うメンバーに反映されます。','Cancel':'キャンセル','Saving…':'保存中…','Save':'保存','Enter a value, or choose is empty to find blank values.':'条件の値を入力してください。空欄の検索には「が空」を選びます。'} as Record<string,string>)[key]?.replace(/\{(\w+)\}/g,(_,name)=>String(values?.[name]??''))??key}))
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

test('calendar time zone search includes the runtime IANA catalog and saves valid zones',async()=>{
  vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
  const save=vi.fn().mockResolvedValue(undefined)
  let tree:ReturnType<typeof create>
  act(()=>{tree=create(<AppViewControls view={{id:'calendar',name:'Calendar',type:'calendar',timeZone:'UTC'}} columns={[]} canEdit save={save}/> )})
  const input=tree!.root.findByProps({'aria-label':'カレンダーのタイムゾーン'})
  expect(input.props.list).toBeTruthy()
  const zones=tree!.root.findAllByType('option').map(option=>option.props.value)
  expect(zones).toContain('Asia/Singapore')
  expect(zones).toContain('America/Phoenix')
  await act(async()=>{input.props.onChange({target:{value:'Asia/Singapore'}});await Promise.resolve()})
  expect(save).toHaveBeenCalledWith({timeZone:'Asia/Singapore'})
  act(()=>input.props.onChange({target:{value:'Mars/Olympus'}}))
  expect(save).toHaveBeenCalledTimes(1)
  expect(tree!.root.findByProps({role:'alert'}).children).toContain('有効なIANAタイムゾーンを入力してください。')
  act(()=>tree!.unmount())
})
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

test('IME Escape keeps the unsaved filter open; ordinary Escape still cancels it',()=>{
  const ui=setup(undefined,undefined,[{id:'title',name:'タイトル',type:'text'}])
  ui.click('フィルター');ui.click('フィルターを調整');ui.click('条件を追加')
  act(()=>ui.tree.root.findByProps({'aria-label':'条件1の値'}).props.onChange({target:{value:'編集中'}}))
  const root=()=>ui.tree.root.findByProps({className:'hx-view-controls'})
  const send=(nativeEvent:object)=>{const stop=vi.fn();act(()=>root().props.onKeyDown({key:'Escape',nativeEvent,stopPropagation:stop}));return stop}
  expect(send({isComposing:true})).not.toHaveBeenCalled()
  expect(send({keyCode:229})).not.toHaveBeenCalled()
  expect(ui.tree.root.findByProps({'aria-label':'条件1の値'}).props.value).toBe('編集中')
  expect(ui.save).not.toHaveBeenCalled()
  expect(send({isComposing:false,keyCode:27})).toHaveBeenCalledOnce()
  expect(ui.tree.root.findAllByProps({role:'dialog'})).toHaveLength(0)
  ui.click('フィルター');ui.click('フィルターを調整')
  expect(ui.tree.root.findAllByProps({'aria-label':'条件1の値'})).toHaveLength(0)
  expect(ui.save).not.toHaveBeenCalled()
  act(()=>ui.tree.unmount())
})

test('a filter can still be saved after Escape is used for IME composition',async()=>{
  const ui=setup(undefined,undefined,[{id:'title',name:'タイトル',type:'text'}])
  ui.click('フィルター');ui.click('フィルターを調整');ui.click('条件を追加')
  act(()=>ui.tree.root.findByProps({'aria-label':'条件1の値'}).props.onChange({target:{value:'日本語'}}))
  act(()=>ui.tree.root.findByProps({className:'hx-view-controls'}).props.onKeyDown({key:'Escape',nativeEvent:{isComposing:true},stopPropagation:vi.fn()}))
  await act(async()=>{ui.tree.root.findAllByType('button').find(b=>b.children.includes('保存'))!.props.onClick();await Promise.resolve()})
  expect(ui.save).toHaveBeenCalledWith({filters:[{column:'title',op:'eq',value:'日本語'}],where:{}})
  expect(ui.tree.root.findAllByProps({role:'dialog'})).toHaveLength(0)
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

test('multi-relation exclusion filters show and persist the negative operator',async()=>{
 vi.stubGlobal('window',{innerWidth:1280,innerHeight:800,addEventListener:vi.fn(),removeEventListener:vi.fn()});
 const save=vi.fn().mockResolvedValue(undefined),relationColumns=[{id:'watchers',name:'Watchers',type:'relation' as const,targetEntity:'customers',multiple:true}];
 const relationEntities=[{key:'customers',table:{columns:[{id:'name',name:'Name',type:'text' as const}]},rows:[{id:'customer_1',values:{name:'Acme'},updatedAt:'2026-10-18T00:00:00Z'},{id:'customer_2',values:{name:'Beacon'},updatedAt:'2026-10-18T00:00:00Z'}]}];
 const ui=setup(save,undefined,relationColumns,relationEntities);ui.click('フィルター');ui.click('フィルターを調整');ui.click('条件を追加');
 const operator=ui.tree.root.findByProps({'aria-label':'条件1の演算子'});
 expect(operator.findAllByType('option').map(option=>option.props.children)).toContain('を含まない');
 act(()=>operator.props.onChange({target:{value:'neq'}}));
 act(()=>ui.tree.root.findByProps({'aria-label':'Watchers'}).props.onClick());
 const search=ui.tree.root.findByProps({'aria-label':'Watchersを検索'});act(()=>search.props.onChange({target:{value:'Beacon'}}));
 const beacon=ui.tree.root.findAllByProps({role:'option'}).find(option=>option.findAllByType('span').some(span=>span.children.includes('Beacon')))!;act(()=>beacon.props.onClick());
 await act(async()=>{ui.tree.root.findAllByType('button').find(button=>button.children.includes('保存'))!.props.onClick();await Promise.resolve()});
 expect(save).toHaveBeenCalledWith({filters:[{column:'watchers',op:'neq',value:'customer_2'}],where:{}});
 act(()=>ui.tree.update(<AppViewControls view={{...view,filters:[{column:'watchers',op:'neq',value:'customer_2'}]}} columns={relationColumns} relationEntities={relationEntities} canEdit save={save}/>));
 ui.click('フィルター');expect(ui.tree.root.findAllByType('p').map(item=>item.children.join('')).join(' ')).toContain('Watchers を含まない Beacon');
 act(()=>ui.tree.unmount())
})

 test('filter adjustment opens direct editing first and keeps AI suggestions as a secondary action',()=>{
 const onAdjust=vi.fn();const ui=setup(undefined,onAdjust)
 ui.click('フィルター');ui.click('フィルターを調整')
 expect(onAdjust).not.toHaveBeenCalled()
 expect(ui.tree.root.findByProps({role:'dialog','aria-label':'フィルターを編集'})).toBeDefined()
 expect(ui.save).not.toHaveBeenCalled()
 ui.click('キャンセル');ui.click('フィルター');ui.click('AIに調整案を相談')
 expect(onAdjust).toHaveBeenCalledTimes(1)
 expect(ui.tree.root.findAllByProps({role:'dialog'})).toHaveLength(0)
 ui.click('フィルター');ui.click('フィルターを調整');ui.click('条件を追加')
 expect(ui.tree.root.findByProps({'aria-label':'条件1の値'})).toBeDefined()
 act(()=>ui.tree.unmount())
 })

test('group adjustment opens direct editing first and retains AI suggestions as a secondary action',()=>{
 const adjust=vi.fn();const ui=setup(undefined,adjust)
 ui.click('グループ化');ui.click('グループ化を調整')
 expect(adjust).not.toHaveBeenCalled();expect(ui.save).not.toHaveBeenCalled()
 expect(ui.tree.root.findByProps({'aria-label':'グループ化するフィールド'})).toBeDefined()
 ui.click('キャンセル');ui.click('グループ化');ui.click('AIに調整案を相談')
 expect(adjust).toHaveBeenCalledWith('group')
 act(()=>ui.tree.unmount())
})
