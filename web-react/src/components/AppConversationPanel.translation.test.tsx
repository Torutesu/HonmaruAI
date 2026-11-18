import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import ja from '../utils/locales/ja'
import es from '../utils/locales/es'
import fr from '../utils/locales/fr'
import de from '../utils/locales/de'
import {AppConversationPanel} from './AppConversationPanel'

const state=vi.hoisted(()=>({locale:'en',dictionary:{} as Record<string,string>,mentions:[] as Array<{name:string;detail?:string}>}))
vi.mock('../utils/i18n',()=>({useT:()=> (key:string,values?:Record<string,string|number>)=>{
  const template=state.dictionary[key]||key
  return template.replace(/\{(\w+)\}/g,(_match,name)=>String(values?.[name]??`{${name}}`))
}}))
vi.mock('../utils/locale',()=>({getLocale:()=>state.locale}))
vi.mock('./MentionMenu',()=>({useMentionMenu:(_box:unknown,_draft:string,_save:unknown,mentionables:Array<{name:string;detail?:string}>)=>{
  state.mentions=mentionables
  return {menu:null,track:vi.fn(),onKeyDown:()=>false}
}}))
afterEach(()=>{vi.unstubAllGlobals();state.locale='en';state.dictionary={};state.mentions=[]})

const dictionaries:Record<string,Record<string,string>>={en:{},ja,es,fr,de}
const message=(id:number,createdAt='2026-03-04T05:06:00.000Z')=>({id,body:'Keep user content as written',authorId:'member-1',authorName:'User supplied name',createdAt})
const expected=(key:string,locale:string)=>dictionaries[locale][key]||key
const chromeKeys=['Everyone','Notify members who can access this app.','Record conversation','App conversation','Refresh conversation','Close chat','Conversation messages','Earlier messages','Start a conversation about this record','Start a conversation about this app','Conversation is saved with this record.','Conversation is saved with this app.','Open source thread','Source thread','Original conversation','Member','Earlier app conversation','AI is preparing a reply…','AI record change proposal','Proposed change','Checking change…','Change applied','Change undone','Proposal declined','Change could not be applied','Processing…','Review and apply','Decline','A member with edit access can review this change.','Undo','Carry over a source thread','Future messages will also appear in the selected thread. Its existing access rules stay in place.','Choose a thread','No selectable threads are available in rooms linked to this app.','Reload','Message input','Write a message… @ to mention','Ask AI','Send with {shortcut}','Send message']

test.each(['ja','es','fr','de'])('provides translated copy for all App/record conversation chrome in %s',locale=>{
  for(const key of chromeKeys)expect(dictionaries[locale][key],`${locale}: ${key}`).toBeTruthy()
  for(const key of chromeKeys)expect(dictionaries[locale][key],`${locale}: ${key}`).not.toBe(key)
})

async function mount(locale:string,props:Record<string,unknown>={}){
  state.locale=locale
  state.dictionary=dictionaries[locale]
  vi.stubGlobal('document',{visibilityState:'visible'})
  const {conversationData,...componentProps}=props
  const data=conversationData&&typeof conversationData==='object'?conversationData as Record<string,unknown>:{}
  const api:any={orgId:'org-1',conversation:vi.fn().mockResolvedValue({threadId:'record-thread',messages:[message(1)],hasMore:false,...data}),members:undefined}
  let tree!:ReturnType<typeof create>
  await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app-1" tableId="table-1" rowId="row-1" title="User title" {...componentProps}/>)})
  return {tree,api}
}

test.each(['en','ja','es','fr','de'])('localizes record conversation chrome, mention metadata, proposal actions, and dates for %s',async locale=>{
  const statuses=['pending','applying','applied','undone','rejected','stale']
  const proposals=statuses.map((status,index)=>({id:`proposal-${index}`,status,fields:[{id:'title',name:'Title',value:'New value'}],expiresAt:'2099-01-01T00:00:00.000Z',appliedUpdatedAt:'2026-03-04T05:06:00.000Z'}))
  const onClose=vi.fn()
  const {tree}=await mount(locale,{onClose,conversationData:{proposals,canEditRecord:true}})
  const rendered=JSON.stringify(tree.toJSON())
  expect(tree.root.findByProps({className:'hx-object-chat'}).props['aria-label']).toBe(expected('Record conversation',locale))
  expect(tree.root.findByProps({role:'log'}).props['aria-label']).toBe(expected('Conversation messages',locale))
  expect(tree.root.findByProps({'aria-label':expected('Refresh conversation',locale)})).toBeTruthy()
  expect(tree.root.findByProps({'aria-label':expected('Close chat',locale)})).toBeTruthy()
  expect(tree.root.findByType('textarea').props['aria-label']).toBe(expected('Message input',locale))
  expect(tree.root.findByType('textarea').props.placeholder).toBe(expected('Write a message… @ to mention',locale))
  for(const key of ['AI record change proposal','Proposed change','Checking change…','Change applied','Change undone','Proposal declined','Change could not be applied'])expect(rendered).toContain(expected(key,locale))
  expect(tree.root.findAllByType('button').some(button=>button.children.includes(expected('Review and apply',locale)))).toBe(true)
  expect(state.mentions).toContainEqual({ref:'__channel',name:expected('Everyone',locale),handle:'channel',special:'channel',detail:expected('Notify members who can access this app.',locale)})
  expect(tree.root.findByType('time').children.join('')).toBe(new Date(message(1).createdAt).toLocaleString(locale))
  expect(tree.root.findByType('time').props.dateTime).toBe(message(1).createdAt)
  expect(rendered).toContain('Keep user content as written')
  expect(rendered).toContain('User supplied name')
  act(()=>tree.unmount())
})

test.each(['en','ja','es','fr','de'])('localizes inherited source conversation and its timestamp for %s',async locale=>{
  const sourceMessage={id:'source-1',body:'Original user text',createdAt:'2027-12-31T23:58:00.000Z',authorName:'Source author',kind:'human'}
  const currentMessage=message(2,'2026-03-04T05:06:00.000Z')
  state.locale=locale
  state.dictionary=dictionaries[locale]
  vi.stubGlobal('document',{visibilityState:'visible'})
  const api:any={orgId:'org-1',conversation:vi.fn().mockResolvedValue({threadId:'app-thread',messages:[currentMessage],hasMore:false,source:{threadId:'source-thread',channel:'b:ops',messages:[sourceMessage]}})}
  let tree!:ReturnType<typeof create>
  await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app-1" title="User title"/>)})
  expect(tree.root.findByProps({className:'hx-object-chat'}).props['aria-label']).toBe(expected('App conversation',locale))
  const sourceLink=tree.root.findByProps({href:'#/apps/app-1/org-1?source=1'})
  expect(sourceLink.props['aria-label']).toBe(expected('Open source thread',locale))
  expect(JSON.stringify(tree.toJSON())).toContain(expected('Source thread',locale))
  expect(tree.root.findAllByType('time')).toHaveLength(2)
  expect(tree.root.findAllByType('time').map(time=>time.children.join(''))).toEqual([new Date(sourceMessage.createdAt).toLocaleString(locale),new Date(currentMessage.createdAt).toLocaleString(locale)])
  expect(tree.root.findAllByType('time').map(time=>time.props.dateTime)).toEqual([sourceMessage.createdAt,currentMessage.createdAt])
  expect(JSON.stringify(tree.toJSON())).toContain(expected('Earlier app conversation',locale))
  expect(JSON.stringify(tree.toJSON())).toContain('Original user text')
  act(()=>tree.unmount())
})
