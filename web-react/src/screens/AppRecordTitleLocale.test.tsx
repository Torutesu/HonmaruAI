import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppView} from './Harness'
import {changeLocale,localeReady,t} from '../utils/i18n'

vi.mock('../utils/appPins',()=>({useAppPins:()=>({pins:[],toggle:vi.fn()})}))
vi.mock('../components/Dialog',()=>({Dialog:({children,title,footer}:any)=><section role="dialog"><h2>{title}</h2>{children}{footer}</section>}))
afterEach(()=>{changeLocale('en');vi.unstubAllGlobals()})

test.each(['en','ja','de','es','fr'])('the create button and dialog use the same translated title in %s',async locale=>{
 const storage=new Map<string,string>()
 vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)})
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),visibilityState:'visible',documentElement:{lang:''}})
 changeLocale(locale);await localeReady()
 const view={id:'all',type:'table',name:'All',rows:[]},app={id:'tasks',name:'Project',description:'',icon:'grid',tableId:'tasks',version:1,channels:[],definition:{views:[view]}}
 const api:any={app:vi.fn().mockResolvedValue({app,table:{id:'tasks',name:'Project',columns:[{id:'title',name:'Issue名',type:'text'}]},rows:[],views:[view],canCustomize:true}),personalViews:vi.fn().mockResolvedValue({revision:0,views:[],computed:[],layouts:{}}),conversation:vi.fn().mockResolvedValue({messages:[],annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),addRow:vi.fn()}
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppView httpBase="https://example.invalid" orgId="team:one" sessionToken="test" onClose={()=>{}} api={api} appId="tasks" onBack={()=>{}} initialSection="data"/>);await new Promise(resolve=>setTimeout(resolve,0))})
 const expected=t('New {name}').replace('{name}',()=> 'Issue')
 const button=tree.root.findByProps({className:'pill-btn hx-create-record'})
 expect(button.props['aria-label']).toBe(expected)
 act(()=>button.props.onClick())
 const dialog=tree.root.findByProps({role:'dialog'})
 expect(dialog.findByType('h2').children.join('')).toBe(expected)
 expect(api.addRow).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})
