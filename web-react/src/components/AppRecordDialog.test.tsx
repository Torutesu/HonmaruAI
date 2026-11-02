import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppRecordDialog} from './AppRecordDialog'
vi.mock('./Dialog',()=>({Dialog:({children,footer,onClose,title,lede}:any)=><div><h2>{title}</h2><p>{lede}</p><button onClick={onClose}>閉じる</button>{children}{footer}</div>}))
afterEach(()=>vi.unstubAllGlobals())
const columns=[{id:'title',name:'タスク名',type:'text' as const},{id:'count',name:'件数',type:'number' as const},{id:'state',name:'状態',type:'select' as const,options:['未着手','完了']}]
test('a distinct table label names the new record while the app title stays in its description',()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="UI確認用タスク" tableName="タスク" columns={columns} save={vi.fn()} onClose={()=>{}}/>)});
 expect(tree!.root.findByType('h2').children.join('')).toBe('新規タスク')
 expect(tree!.root.findByType('p').children.join('')).toBe('UI確認用タスクに新しいレコードを作成します。')
 act(()=>tree!.unmount())
})
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

test('closing changed record asks before discarding and preserves draft when continuing',()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});const onClose=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={columns} record={{id:'r',values:{title:'Original'},updatedAt:'2026-10-18'}} conversation={<textarea aria-label="chat" defaultValue="unsent"/>} save={vi.fn()} onClose={onClose}/>)});
 act(()=>tree!.root.findAllByType('textarea')[0].props.onChange({target:{value:'Changed'}}))
 act(()=>tree!.root.findAllByType('button').find(button=>button.children.includes('キャンセル'))!.props.onClick())
 expect(onClose).not.toHaveBeenCalled();expect(tree!.root.findAllByType('h2').map(x=>x.children.join(''))).toContain('Discard unsaved record changes?')
 act(()=>tree!.root.findAllByType('button').find(button=>button.children.includes('Keep editing'))!.props.onClick())
 expect(tree!.root.findAllByType('textarea')[0].props.value).toBe('Changed');expect(tree!.root.findByProps({'aria-label':'chat'}).props.defaultValue).toBe('unsent')
 act(()=>tree!.root.findAllByType('button').find(button=>button.children.includes('キャンセル'))!.props.onClick())
 act(()=>tree!.root.findAllByType('button').find(button=>button.children.includes('Discard changes'))!.props.onClick())
 expect(onClose).toHaveBeenCalledOnce();act(()=>tree!.unmount())
})

test('restoring equivalent values and unchanged initial new-record values closes without warning',()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});const onClose=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={columns} record={{id:'r',values:{title:'Original',count:12},updatedAt:'2026-10-18'}} save={vi.fn()} onClose={onClose}/>)});
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'Changed'}}));act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'Original'}}))
 act(()=>tree!.root.findByType('input').props.onChange({target:{value:'12'}}))
 act(()=>tree!.root.findAllByType('button').find(button=>button.children.includes('キャンセル'))!.props.onClick());expect(onClose).toHaveBeenCalledOnce();act(()=>tree!.unmount())
 onClose.mockClear();act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={columns} initial={{title:'Prefilled'}} save={vi.fn()} onClose={onClose}/>)});
 act(()=>tree!.root.findAllByType('button').find(button=>button.children.includes('キャンセル'))!.props.onClick());expect(onClose).toHaveBeenCalledOnce();act(()=>tree!.unmount())
})

test('incomplete browser input prompts even when no React change event was received',()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});const onClose=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={columns} record={{id:'r',values:{title:'Original'},updatedAt:'2026-10-18'}} save={vi.fn()} onClose={onClose}/>,{createNodeMock:node=>node.type==='form'?{querySelectorAll:()=>[{validity:{badInput:true}}]}:null})});
 act(()=>tree!.root.findAllByType('button').find(button=>button.children.includes('キャンセル'))!.props.onClick())
 expect(onClose).not.toHaveBeenCalled();expect(tree!.root.findAllByType('h2').map(x=>x.children.join(''))).toContain('Discard unsaved record changes?');act(()=>tree!.unmount())
})

test('restoring multiple related records in the original order is not a pending change',()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal('window',{innerWidth:1280,innerHeight:800,addEventListener:vi.fn(),removeEventListener:vi.fn()});const onClose=vi.fn();let tree:ReturnType<typeof create>
 const relation={id:'related',name:'Related',type:'relation' as const,targetEntity:'items',multiple:true}
 const rows=[{id:'a',values:{name:'A'},updatedAt:'2026-10-18'},{id:'b',values:{name:'B'},updatedAt:'2026-10-18'}]
 act(()=>{tree=create(<AppRecordDialog appName="Tasks" columns={[relation]} record={{id:'r',values:{related:['a','b']},updatedAt:'2026-10-18'}} relationEntities={[{key:'items',table:{id:'items',name:'Items',columns:[{id:'name',name:'Name',type:'text'}]},rows}]} save={vi.fn()} onClose={onClose}/>)});
 act(()=>tree!.root.findByProps({'aria-label':'Related'}).props.onClick())
 const option=()=>tree!.root.findAllByProps({role:'option'}).find(button=>button.findAllByType('span').some(span=>span.children.includes('B')))!
 act(()=>option().props.onClick());act(()=>option().props.onClick())
 act(()=>tree!.root.findAllByType('button').find(button=>button.children.includes('キャンセル'))!.props.onClick())
 expect(onClose).toHaveBeenCalledOnce();act(()=>tree!.unmount())
})

test('relation fields select same-app records and support multiple links',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});
 vi.stubGlobal('window',{innerWidth:1280,innerHeight:800,addEventListener:vi.fn(),removeEventListener:vi.fn()});
 const save=vi.fn().mockResolvedValue(undefined),customer={id:'customer_1',values:{name:'Acme'},updatedAt:'2026-10-18T00:00:00Z'};
 const other={id:'customer_2',values:{name:'Beacon'},updatedAt:'2026-10-18T00:00:00Z'};
 const relationEntities=[{key:'customers',table:{id:'customers',name:'Customers',columns:[{id:'name',name:'Name',type:'text' as const}]},rows:[customer,other]}];
 const relationColumns=[{id:'customer',name:'Customer',type:'relation' as const,targetEntity:'customers'},{id:'watchers',name:'Watchers',type:'relation' as const,targetEntity:'customers',multiple:true}];
 let tree:ReturnType<typeof create>;
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={relationColumns} relationEntities={relationEntities} save={save} onClose={()=>{}}/>)});
 const customerPicker=tree!.root.findByProps({'aria-label':'Customer'}),watchersPicker=tree!.root.findByProps({'aria-label':'Watchers'});
 act(()=>customerPicker.props.onClick());
 act(()=>tree!.root.findByProps({'aria-label':'Customerを検索'}).props.onChange({target:{value:'Acm'}}));
 expect(tree!.root.findAllByProps({role:'option'}).some(option=>option.findAllByType('span').some(span=>span.children.includes('Acme')))).toBe(true);
 expect(tree!.root.findAllByProps({role:'option'}).some(option=>option.findAllByType('span').some(span=>span.children.includes('Beacon')))).toBe(false);
 const acme=tree!.root.findAllByProps({role:'option'}).find(option=>option.findAllByType('span').some(span=>span.children.includes('Acme')))!;
 act(()=>acme.props.onClick());
 act(()=>watchersPicker.props.onClick());
 const watcherOption=tree!.root.findAllByProps({role:'option'}).find(option=>option.findAllByType('span').some(span=>span.children.includes('Acme')))!;
 act(()=>watcherOption.props.onClick());
 expect(tree!.root.findAllByProps({className:'hx-relation-chip'})).toHaveLength(1);
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})});
 expect(save).toHaveBeenCalledWith({customer:'customer_1',watchers:['customer_1']});
 act(()=>tree!.unmount());
})

test('relation picker searches by label or id, supports keyboard selection and clears a single link',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});
 vi.stubGlobal('window',{innerWidth:1280,innerHeight:800,addEventListener:vi.fn(),removeEventListener:vi.fn()});
 const save=vi.fn().mockResolvedValue(undefined),rows=[{id:'record_1',values:{name:'Acme'},updatedAt:'2026-10-18T00:00:00Z'},{id:'record_2',values:{name:'Beacon'},updatedAt:'2026-10-18T00:00:00Z'}];let tree:ReturnType<typeof create>
 const relation={id:'customer',name:'Customer',type:'relation' as const,targetEntity:'customers'}
 act(()=>{tree=create(<AppRecordDialog appName="Tasks" columns={[relation]} relationEntities={[{key:'customers',table:{id:'customers',name:'Customers',columns:[{id:'name',name:'Name',type:'text' as const}]},rows}]} save={save} onClose={()=>{}}/>)});
 const trigger=tree!.root.findByProps({'aria-label':'Customer'});act(()=>trigger.props.onClick());
 const search=tree!.root.findByProps({'aria-label':'Customerを検索'});act(()=>search.props.onChange({target:{value:'record_2'}}));
 act(()=>search.props.onKeyDown({key:'Enter',nativeEvent:{isComposing:false},preventDefault:vi.fn()}));
 expect(tree!.root.findByProps({'aria-label':'Customer'}).props['aria-expanded']).toBe(false);
 expect(tree!.root.findByProps({'aria-label':'Customer'}).findAllByType('span').some(span=>span.children.includes('Beacon'))).toBe(true);
 act(()=>tree!.root.findByProps({'aria-label':'Customer'}).props.onClick());
 const clear=tree!.root.findAllByProps({className:'hx-relation-option'}).find(button=>button.findAllByType('span').some(span=>span.children.join('')==='Customerなし'))!;act(()=>clear.props.onClick());
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})});
 expect(save).toHaveBeenCalledWith({customer:null});act(()=>tree!.unmount())
})
