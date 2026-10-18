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
