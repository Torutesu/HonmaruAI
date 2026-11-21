import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import ja from '../utils/locales/ja'
import es from '../utils/locales/es'
import fr from '../utils/locales/fr'
import de from '../utils/locales/de'
import {AppConversationInbox} from './AppConversationInbox'
const state=vi.hoisted(()=>({dictionary:{} as Record<string,string>}))
vi.mock('../utils/i18n',()=>{const translate=(key:string)=>state.dictionary[key]||key;return {useT:()=>translate}})
afterEach(()=>{vi.unstubAllGlobals();state.dictionary={}})

const dictionaries:Record<string,Record<string,string>>={en:{},ja,es,fr,de}
const expected=(key:string,locale:string)=>dictionaries[locale][key]||key

test.each(['ja','es','fr','de'])('translates every app conversation notification label and state in %s',locale=>{
 const keys=['App','Conversation notifications','Conversation notifications (unread)','No new notifications','Could not load notifications.','Could not open notification.','AI reply','You were mentioned','Record']
 for(const key of keys){expect(dictionaries[locale][key],`${locale}: ${key}`).toBeTruthy();if(!(locale==='de'&&key==='App'))expect(dictionaries[locale][key],`${locale}: ${key}`).not.toBe(key)}
})

test.each(['en','ja','es','fr','de'])('renders translated notification chrome and metadata in %s',async locale=>{
 state.dictionary=dictionaries[locale]
 vi.stubGlobal('document',{visibilityState:'visible'})
 const items=[
  {messageId:7,body:'AI update',tableId:'table',rowId:'record',readAt:null,kind:'ai'},
  {messageId:8,body:'Mention update',tableId:'table',rowId:'',readAt:'2026-01-01T00:00:00.000Z',kind:'mention'},
 ]
 const api:any={conversationNotifications:vi.fn().mockResolvedValue({items}),readConversationNotification:vi.fn().mockResolvedValue({})}
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationInbox api={api} appId="app" onOpen={vi.fn()}/>);await Promise.resolve()})
 const unreadLabel=expected('Conversation notifications (unread)',locale)
 expect(tree!.root.findByProps({['aria-label']:unreadLabel,'aria-expanded':false})).toBeTruthy()
 act(()=>tree!.root.findByProps({['aria-label']:unreadLabel,'aria-expanded':false}).props.onClick())
 expect(tree!.root.findByProps({role:'region','aria-label':unreadLabel})).toBeTruthy()
 const rendered=JSON.stringify(tree!.toJSON())
 expect(rendered).toContain(expected('AI reply',locale))
 expect(rendered).toContain(expected('You were mentioned',locale))
 expect(rendered).toContain(expected('Record',locale))
 expect(rendered).toContain(expected('App',locale))
 expect(rendered).toContain('AI update')
 expect(rendered).toContain('Mention update')
 act(()=>tree!.unmount())
})

test.each(['en','ja','es','fr','de'])('localizes notification loading and opening errors in %s',async locale=>{
 state.dictionary=dictionaries[locale]
 vi.stubGlobal('document',{visibilityState:'visible'})
 const api:any={conversationNotifications:vi.fn().mockResolvedValue({items:[{messageId:7,body:'Review',tableId:'table',rowId:'record',readAt:null,kind:'mention'}]}),readConversationNotification:vi.fn().mockRejectedValue(new Error('offline'))}
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationInbox api={api} appId="app" onOpen={vi.fn()}/>);await Promise.resolve()})
 const label=expected('Conversation notifications (unread)',locale)
 act(()=>tree!.root.findByProps({['aria-label']:label,'aria-expanded':false}).props.onClick())
 const item=tree!.root.findAllByType('button').find(button=>button.props.className==='unread')!
 await act(async()=>{await item.props.onClick()})
 expect(tree!.root.findByProps({role:'alert'}).children.join('')).toBe(expected('Could not open notification.',locale))
 act(()=>tree!.unmount())
})

test.each(['en','ja','es','fr','de'])('shows a localized load error in the open notification panel in %s',async locale=>{
 state.dictionary=dictionaries[locale]
 vi.stubGlobal('document',{visibilityState:'visible'})
 const api:any={conversationNotifications:vi.fn().mockRejectedValue(new Error('offline'))}
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationInbox api={api} appId="app" onOpen={vi.fn()}/>);await Promise.resolve()})
 const label=expected('Conversation notifications',locale)
 act(()=>tree!.root.findByProps({['aria-label']:label,'aria-expanded':false}).props.onClick())
 expect(tree!.root.findByProps({role:'alert'}).children.join('')).toBe(expected('Could not load notifications.',locale))
 expect(tree!.toJSON()).toBeTruthy()
 act(()=>tree!.unmount())
})
test('notification opens its exact record only after its read state has saved',async()=>{
 const item={messageId:7,body:'Review',tableId:'table',rowId:'record',readAt:null,kind:'mention'};
 const api:any={conversationNotifications:vi.fn().mockResolvedValue({items:[item]}),readConversationNotification:vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({})};const onOpen=vi.fn();let tree:ReturnType<typeof create>;
 await act(async()=>{tree=create(<AppConversationInbox api={api} appId="app" onOpen={onOpen}/>)});act(()=>tree!.root.findByProps({'aria-expanded':false}).props.onClick());
 const open=()=>tree!.root.findAllByType('button').find(b=>b.props.className==='unread')!.props.onClick();await act(async()=>{await open()});expect(onOpen).not.toHaveBeenCalled();expect(api.readConversationNotification).toHaveBeenCalledWith('app',7);
 // A failed read leaves the unread entry available after closing/reopening.
 act(()=>tree!.root.findByProps({'aria-expanded':true}).props.onClick());act(()=>tree!.root.findByProps({'aria-expanded':false}).props.onClick());
 await act(async()=>{await open()});expect(onOpen).toHaveBeenCalledWith({tableId:'table',rowId:'record'});act(()=>tree!.unmount());
})
