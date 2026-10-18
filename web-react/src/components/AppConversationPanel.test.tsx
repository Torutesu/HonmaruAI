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
