import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppConversationPanel,mergeMessages} from './AppConversationPanel'
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
const message=(id:number,body='hello')=>({id,body,authorId:'u',authorName:'User',createdAt:'2026-10-18T00:00:00Z'})
test('retry preserves the draft and request identity, and duplicate submits are suppressed',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'});const api:any={conversation:vi.fn().mockResolvedValue({threadId:'app',messages:[],hasMore:false}),postConversation:vi.fn().mockRejectedValueOnce(new Error('Network')).mockResolvedValue({messageId:1})};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" title="App"/>)});
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'Draft'}}));
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})});expect(tree!.root.findByType('textarea').props.value).toBe('Draft');expect(tree!.root.findByProps({role:'alert'}).children[0]).toBe('Network');
 await act(async()=>{void tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()});await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})});
 expect(api.postConversation).toHaveBeenCalledTimes(2);expect(api.postConversation.mock.calls[0][3]).toBe(api.postConversation.mock.calls[1][3]);expect(tree!.root.findByType('textarea').props.value).toBe('');act(()=>tree!.unmount())
})
test('record proposals require an explicit confirmation and expose undo after apply',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'});
 const proposal={id:'rp_1',status:'pending',fields:[{id:'title',name:'Title',value:'Updated'}],expiresAt:'2099-01-01T00:00:00.000Z'};
 const api:any={conversation:vi.fn().mockResolvedValueOnce({threadId:'record',messages:[],hasMore:false,proposals:[proposal],canEditRecord:true}).mockResolvedValue({threadId:'record',messages:[],hasMore:false,proposals:[{...proposal,status:'applied',appliedUpdatedAt:'2026-11-08T00:00:00.000Z'}],canEditRecord:true}),reviewRecordProposal:vi.fn().mockResolvedValue({ok:true,status:'applied'})};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" tableId="t" rowId="r" title="Record"/>)});
 expect(JSON.stringify(tree!.toJSON())).toContain('Updated');
 const approve=tree!.root.findAllByType('button').find(button=>button.children.includes('確認して適用'))!;
 await act(async()=>{await approve.props.onClick()});
 expect(api.reviewRecordProposal).toHaveBeenCalledWith('app','rp_1','approve');
 expect(JSON.stringify(tree!.toJSON())).toContain('変更を適用しました');
 act(()=>tree!.unmount())
})
test('late responses from a previous record cannot appear in the current conversation',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'});let resolve!:(v:any)=>void;
 const api:any={conversation:vi.fn().mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValue({threadId:'new',messages:[message(2,'new record')],hasMore:false})};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" tableId="table" rowId="old" title="Record"/>)});
 await act(async()=>{tree!.update(<AppConversationPanel api={api} appId="app" tableId="table" rowId="new" title="Record"/>)});
 await act(async()=>resolve({threadId:'old',messages:[message(1,'private old record')],hasMore:false}));expect(JSON.stringify(tree!.toJSON())).not.toContain('private old record');expect(JSON.stringify(tree!.toJSON())).toContain('new record');act(()=>tree!.unmount())
})
test('lost access clears the visible history and older pages remain deduplicated',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'});const api:any={conversation:vi.fn().mockResolvedValueOnce({threadId:'a',messages:[message(2)],hasMore:true}).mockResolvedValueOnce({threadId:'a',messages:[message(1)],hasMore:false}).mockRejectedValue(new Error('No such app.'))};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" title="App"/>)});
 await act(async()=>{await tree!.root.findAllByType('button').find(b=>b.children.includes('以前のメッセージ'))!.props.onClick()});expect(tree!.root.findAllByType('article')).toHaveLength(2);
 await act(async()=>{await tree!.root.findByProps({'aria-label':'会話を更新'}).props.onClick()});expect(tree!.root.findAllByType('article')).toHaveLength(0);expect(tree!.root.findByProps({role:'alert'})).toBeTruthy();act(()=>tree!.unmount());expect(mergeMessages([message(2)],[message(1),message(2)])).toHaveLength(2)
})
test('inherited history is shown and disappears when current source access is lost',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'});const api:any={orgId:'team:source',conversation:vi.fn().mockResolvedValueOnce({messages:[],hasMore:false,source:{channel:'b:design',threadId:'root',messages:[{id:'root',body:'Original request',authorName:'Maker',createdAt:'2026-10-18T00:00:00Z'}]}}).mockRejectedValue(new Error('Source access denied'))};let tree:ReturnType<typeof create>;
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" title="App"/>)});expect(JSON.stringify(tree!.toJSON())).toContain('Original request');expect(tree!.root.findByProps({'aria-label':'作成元スレッドを開く'}).props.href).toBe('#/apps/app/team%3Asource?source=1');
 await act(async()=>{await tree!.root.findByProps({'aria-label':'会話を更新'}).props.onClick()});expect(JSON.stringify(tree!.toJSON())).not.toContain('Original request');
 act(()=>tree!.root.findAllByType('button').find(b=>b.props.className==='hx-chat-ai')!.props.onClick());expect(tree!.root.findByType('textarea').props.value).toBe('@AI ');act(()=>tree!.unmount())
})
test('late source candidates and errors cannot cross an account change',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'});let resolve!:(v:any)=>void, reject!:(e:any)=>void;
 const old:any={conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false}),conversationSources:vi.fn().mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockImplementationOnce(()=>new Promise((_,r)=>reject=r))};
 const next:any={conversation:vi.fn().mockResolvedValue({messages:[message(2,'Current account')],hasMore:false})};let tree:ReturnType<typeof create>;
 await act(async()=>{tree=create(<AppConversationPanel api={old} appId="old" title="Old"/>)});
 const find=()=>tree!.root.findAllByType('button').find(b=>b.children.includes('作成元スレッドを引き継ぐ'))!;
 act(()=>{find().props.onClick();find().props.onClick()});
 await act(async()=>{tree!.update(<AppConversationPanel api={next} appId="new" title="New"/>)});
 await act(async()=>{resolve({candidates:[{id:'private',body:'Previous account secret',channel:'b:private'}]});reject(new Error('Previous account failure'))});
 expect(JSON.stringify(tree!.toJSON())).not.toContain('Previous account');expect(JSON.stringify(tree!.toJSON())).toContain('Current account');act(()=>tree!.unmount())
})
test('late inheritance cannot refresh the previous account into a new conversation',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'});let finish!:(v:any)=>void;
 const old:any={conversation:vi.fn().mockResolvedValue({messages:[message(1,'Old account')],hasMore:false}),conversationSources:vi.fn().mockResolvedValue({candidates:[{id:'root',body:'Request',channel:'b:old'}]}),inheritConversation:vi.fn(()=>new Promise(r=>finish=r))};
 const next:any={conversation:vi.fn().mockResolvedValue({messages:[message(2,'New account')],hasMore:false})};let tree:ReturnType<typeof create>;
 await act(async()=>{tree=create(<AppConversationPanel api={old} appId="old" title="Old"/>)});
 await act(async()=>{tree!.root.findAllByType('button').find(b=>b.children.includes('作成元スレッドを引き継ぐ'))!.props.onClick()});
 act(()=>tree!.root.findByType('select').props.onChange({target:{value:'root'}}));
 await act(async()=>{tree!.update(<AppConversationPanel api={next} appId="new" title="New"/>)});
 expect(tree!.root.findAllByType('button').find(b=>b.children.includes('作成元スレッドを引き継ぐ'))!.props.disabled).toBe(false);
 await act(async()=>finish({}));
 expect(old.conversation).toHaveBeenCalledTimes(1);expect(JSON.stringify(tree!.toJSON())).not.toContain('Old account');expect(JSON.stringify(tree!.toJSON())).toContain('New account');act(()=>tree!.unmount())
})

test('adjustment context seeds an unsent draft and refresh preserves the users edits',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'})
 const api:any={conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false}),postConversation:vi.fn()};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" title="App" initialDraft="Group this view:"/>)})
 expect(tree!.root.findByType('textarea').props.value).toBe('Group this view:');expect(api.postConversation).not.toHaveBeenCalled()
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'My unfinished reply'}}))
 await act(async()=>{await tree!.root.findByProps({'aria-label':'会話を更新'}).props.onClick()})
 expect(tree!.root.findByType('textarea').props.value).toBe('My unfinished reply');expect(api.postConversation).not.toHaveBeenCalled()
 act(()=>tree!.unmount())
})

test('an adjustment suggestion stays separate from an existing unsent app draft until chosen',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'})
 const consumed=vi.fn(),values=new Map([['app','Existing unsent reply']])
 const drafts={read:(app:string)=>values.get(app)||'',write:(text:string,app:string)=>{if(text)values.set(app,text);else values.delete(app)}}
 const api:any={drafts,conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false}),postConversation:vi.fn()};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" title="App" initialDraft="Adjust only my personal view:" onInitialDraftConsumed={consumed}/>)})
 expect(tree!.root.findByType('textarea').props.value).toBe('Existing unsent reply')
 expect(JSON.stringify(tree!.toJSON())).toContain('Adjust only my personal view:')
 expect(consumed).not.toHaveBeenCalled()
 const append=tree!.root.findAllByType('button').find(button=>button.children.includes('既存の下書きに追加'))!
 act(()=>append.props.onClick())
 expect(tree!.root.findByType('textarea').props.value).toBe('Existing unsent reply\n\nAdjust only my personal view:')
 expect(values.get('app')).toBe('Existing unsent reply\n\nAdjust only my personal view:')
 expect(consumed).toHaveBeenCalledTimes(1)
 expect(JSON.stringify(tree!.toJSON())).not.toContain('今回の調整案')
 act(()=>tree!.unmount())
})

test('seed consumption does not reset edited text when the parent removes the seed',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'})
 const consumed=vi.fn(),api:any={conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false}),postConversation:vi.fn()};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" title="App" initialDraft="Adjust groups:" onInitialDraftConsumed={consumed}/>)})
 expect(consumed).toHaveBeenCalledTimes(1)
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'User revised the suggestion'}}))
 await act(async()=>{tree!.update(<AppConversationPanel api={api} appId="app" title="App" onInitialDraftConsumed={consumed}/>)})
 expect(tree!.root.findByType('textarea').props.value).toBe('User revised the suggestion')
 expect(consumed).toHaveBeenCalledTimes(1);expect(api.postConversation).not.toHaveBeenCalled()
 act(()=>tree!.unmount())
})

test('app and record drafts survive closing, suggestions stay separate and drafts clear only after successful send',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'})
 const values=new Map<string,string>(),drafts={read:(app:string,table?:string,row?:string)=>values.get(JSON.stringify([app,table,row]))||'',write:(text:string,app:string,table?:string,row?:string)=>values.set(JSON.stringify([app,table,row]),text)}
 const api:any={drafts,conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false}),postConversation:vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({})};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" title="App"/>)})
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'App draft'}}))
 await act(async()=>{tree!.update(<AppConversationPanel api={api} appId="app" tableId="t" rowId="r" title="Record"/>)})
 expect(tree!.root.findByType('textarea').props.value).toBe('')
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'Record draft'}}));act(()=>tree!.unmount())
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" title="App" initialDraft="Suggested adjustment"/>)})
 expect(tree!.root.findByType('textarea').props.value).toBe('App draft')
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})})
 expect(drafts.read('app')).toBe('App draft')
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})})
 expect(drafts.read('app')).toBe('');expect(drafts.read('app','t','r')).toBe('Record draft');act(()=>tree!.unmount())
})
