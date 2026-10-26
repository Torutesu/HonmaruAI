import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppRecordDialog} from './AppRecordDialog'
vi.mock('./Dialog',()=>({Dialog:({children,footer,onClose}:any)=><div><button onClick={onClose}>閉じる</button>{children}{footer}</div>}))
afterEach(()=>vi.unstubAllGlobals())
const columns=[{id:'title',name:'タスク名',type:'text' as const},{id:'count',name:'件数',type:'number' as const},{id:'state',name:'状態',type:'select' as const,options:['未着手','完了']}]
test('opening and cancelling do not create rows; errors preserve drafts and typed submission',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});const save=vi.fn().mockRejectedValueOnce(new Error('保存できません')).mockResolvedValue(undefined),onClose=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={columns} save={save} onClose={onClose}/>)});
 expect(save).not.toHaveBeenCalled();act(()=>tree!.root.findAllByType('button').find(b=>b.children.includes('キャンセル'))!.props.onClick());expect(onClose).toHaveBeenCalledOnce();onClose.mockClear()
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'改行\nタスク'}}));act(()=>tree!.root.findByType('input').props.onChange({target:{value:'0'}}));act(()=>tree!.root.findByType('select').props.onChange({target:{value:'完了'}}))
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})});
 expect(save).toHaveBeenCalledWith({title:'改行\nタスク',count:0,state:'完了'});expect(onClose).not.toHaveBeenCalled();expect(tree!.root.findByType('textarea').props.value).toBe('改行\nタスク');expect(tree!.root.findByProps({role:'alert'}).children).toContain('保存できません')
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})});expect(onClose).toHaveBeenCalledOnce();act(()=>tree!.unmount())
})
test('pending creation blocks duplicate submit and dismissal',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});let resolve!:()=>void;const save=vi.fn(()=>new Promise<void>(r=>resolve=r)),onClose=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={columns} save={save} onClose={onClose}/>)});
 act(()=>{void tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()});void tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})});act(()=>tree!.root.findAllByType('button')[0].props.onClick());expect(save).toHaveBeenCalledOnce();expect(onClose).not.toHaveBeenCalled();await act(async()=>resolve());expect(onClose).toHaveBeenCalledOnce();act(()=>tree!.unmount())
})
test('editing sends only changed fields and explicitly clears values without losing legacy owners',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});const save=vi.fn().mockResolvedValue(undefined);let tree:ReturnType<typeof create>
 const record={id:'row_1',values:{title:'Existing',count:12,owner:'former-member'},createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-18T00:00:00Z'}
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={[...columns,{id:'owner',name:'担当者',type:'person'}]} record={record} members={[{ref:'user_1',name:'メンバー'}]} save={save} onClose={()=>{}}/>)});
 expect(tree!.root.findByProps({role:'combobox'}).findAllByType('span').some(span=>span.children.includes('former-member'))).toBe(true)
 act(()=>tree!.root.findByType('input').props.onChange({target:{value:''}}))
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})});expect(save).toHaveBeenCalledWith({count:null});expect(record.values.count).toBe(12);act(()=>tree!.unmount())
})
test('conflicting edit keeps the draft and does not close',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});const save=vi.fn().mockRejectedValue(new Error('別のユーザーが更新しました')),onClose=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={columns} record={{id:'row_1',values:{title:'Original'},updatedAt:'2026-10-18T00:00:00Z'}} save={save} onClose={onClose}/>)});
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'My changes'}}));await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})});expect(onClose).not.toHaveBeenCalled();expect(tree!.root.findByType('textarea').props.value).toBe('My changes');expect(tree!.root.findByProps({role:'alert'}).children).toContain('別のユーザーが更新しました');act(()=>tree!.unmount())
})

test('relation fields select same-app records and support multiple links',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});
 const save=vi.fn().mockResolvedValue(undefined),customer={id:'customer_1',values:{name:'Acme'},updatedAt:'2026-10-18T00:00:00Z'};
 const relationEntities=[{key:'customers',table:{id:'customers',name:'Customers',columns:[{id:'name',name:'Name',type:'text' as const}]},rows:[customer]}];
 const relationColumns=[{id:'customer',name:'Customer',type:'relation' as const,targetEntity:'customers'},{id:'watchers',name:'Watchers',type:'relation' as const,targetEntity:'customers',multiple:true}];
 let tree:ReturnType<typeof create>;
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={relationColumns} relationEntities={relationEntities} save={save} onClose={()=>{}}/>)});
 const selects=tree!.root.findAllByType('select');expect(selects).toHaveLength(2);expect(selects[1].props.multiple).toBe(true);
 expect(selects[0].findAllByType('option').map(option=>option.children.join(''))).toContain('Acme');
 act(()=>selects[0].props.onChange({target:{value:'customer_1'}}));
 act(()=>selects[1].props.onChange({currentTarget:{selectedOptions:[{value:'customer_1'}]}}));
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})});
 expect(save).toHaveBeenCalledWith({customer:'customer_1',watchers:['customer_1']});
 act(()=>tree!.unmount());
})
