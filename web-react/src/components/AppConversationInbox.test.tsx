import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {AppConversationInbox} from './AppConversationInbox'
test('notification opens its exact record only after its read state has saved',async()=>{
 const item={messageId:7,body:'Review',tableId:'table',rowId:'record',readAt:null,kind:'mention'};
 const api:any={conversationNotifications:vi.fn().mockResolvedValue({items:[item]}),readConversationNotification:vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({})};const onOpen=vi.fn();let tree:ReturnType<typeof create>;
 await act(async()=>{tree=create(<AppConversationInbox api={api} appId="app" onOpen={onOpen}/>)});act(()=>tree!.root.findByProps({'aria-expanded':false}).props.onClick());
 const open=()=>tree!.root.findAllByType('button').find(b=>b.props.className==='unread')!.props.onClick();await act(async()=>{await open()});expect(onOpen).not.toHaveBeenCalled();expect(api.readConversationNotification).toHaveBeenCalledWith('app',7);
 // A failed read leaves the unread entry available after closing/reopening.
 act(()=>tree!.root.findByProps({'aria-expanded':true}).props.onClick());act(()=>tree!.root.findByProps({'aria-expanded':false}).props.onClick());
 await act(async()=>{await open()});expect(onOpen).toHaveBeenCalledWith({tableId:'table',rowId:'record'});act(()=>tree!.unmount());
})
