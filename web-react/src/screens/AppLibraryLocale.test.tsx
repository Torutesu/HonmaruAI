import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {HarnessApps} from './Harness'
import {changeLocale,localeReady,t} from '../utils/i18n'
const state=vi.hoisted(()=>({api:null as any,pins:[] as string[],toggle:async(_id:string)=>{}}))
vi.mock('./HarnessShared',async original=>({...await original<typeof import('./HarnessShared')>(),useApi:()=>state.api}))
vi.mock('../utils/appPins',()=>({useAppPins:()=>({pins:state.pins,toggle:state.toggle})}))
vi.mock('../components/RemoteMcpServers',()=>({RemoteMcpServers:()=>null}))
vi.mock('../components/HarnessAppPreview',()=>({HarnessAppPreview:()=>null}))
afterEach(()=>{changeLocale('en');vi.unstubAllGlobals()})

test('the app search field and empty result follow English and Japanese language changes',async()=>{
 const storage=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)})
 vi.stubGlobal('location',{hash:'#/apps',search:''})
 state.toggle=vi.fn().mockResolvedValue(undefined);state.api={apps:vi.fn().mockResolvedValue({apps:[{id:'a',name:'Alpha',description:'A test',icon:'grid',channels:[]}]}),templates:vi.fn().mockResolvedValue({templates:[]})}
 changeLocale('en');await localeReady();let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<HarnessApps httpBase="https://example.invalid" orgId="team:one" sessionToken="test" onClose={()=>{}}/>);await Promise.resolve()})
 const search=()=>tree!.root.findByType('input')
 expect(search().props['aria-label']).toBe('Search apps');expect(search().props.placeholder).toBe('Search apps');expect(tree!.root.findByProps({'aria-label':'Open Alpha'})).toBeTruthy();expect(tree!.root.findByProps({'aria-label':'Pin Alpha to navigation'}).props['aria-pressed']).toBe(false);await act(async()=>tree!.root.findByProps({'aria-label':'Pin Alpha to navigation'}).props.onClick());expect(state.toggle).toHaveBeenCalledWith('a')
 act(()=>search().props.onChange({target:{value:'missing'}}));expect(tree!.root.findByProps({role:'status'}).children).toContain('No apps match your search.')
 await act(async()=>{changeLocale('ja');await localeReady()})
 expect(search().props['aria-label']).toBe('アプリを検索');expect(search().props.placeholder).toBe('アプリを検索');expect(search().props.value).toBe('missing');expect(tree!.root.findByProps({role:'status'}).children).toContain('該当するアプリがありません。')
 act(()=>search().props.onChange({target:{value:''}}));expect(tree!.root.findAllByProps({'data-app':'a'})).toHaveLength(1);expect(tree!.root.findByProps({'aria-label':'Alphaを開く'})).toBeTruthy();expect(tree!.root.findByProps({'aria-label':'Alphaをナビゲーションに固定'}).props['aria-pressed']).toBe(false)
 state.pins=['a'];act(()=>tree!.update(<HarnessApps httpBase="https://example.invalid" orgId="team:one" sessionToken="test" onClose={()=>{}}/>));expect(tree!.root.findByProps({'aria-label':'Alphaの固定を解除'}).props['aria-pressed']).toBe(true);await act(async()=>tree!.root.findByProps({'aria-label':'Alphaの固定を解除'}).props.onClick());expect(state.toggle).toHaveBeenCalledTimes(2)
 await act(async()=>{changeLocale('en');await localeReady()});expect(tree!.root.findByProps({'aria-label':'Unpin Alpha from navigation'}).props['aria-pressed']).toBe(true);act(()=>tree!.unmount());state.pins=[]
})


test.each([
 ['en','Search apps','No apps match your search.','Pin Alpha to navigation','Unpin Alpha from navigation'],
 ['ja','アプリを検索','該当するアプリがありません。','Alphaをナビゲーションに固定','Alphaの固定を解除'],
 ['de','Apps suchen','Keine Apps entsprechen deiner Suche.','Alpha an die Navigation anheften','Alpha aus der Navigation lösen'],
 ['es','Buscar apps','Ninguna aplicación coincide con tu búsqueda.','Fijar Alpha en la navegación','Desfijar Alpha de la navegación'],
 ['fr','Rechercher une app','Aucune application ne correspond à votre recherche.','Épingler Alpha à la navigation','Désépingler Alpha de la navigation'],
])('app search copy is available in %s',async(locale,search,empty,pin,unpin)=>{
 const storage=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)})
 changeLocale(locale);await localeReady();expect(t('Search apps')).toBe(search);expect(t('No apps match your search.')).toBe(empty);expect(t('Pin {name} to navigation',{name:'Alpha'})).toBe(pin);expect(t('Unpin {name} from navigation',{name:'Alpha'})).toBe(unpin)
})


test.each([['en','Open Alpha'],['ja','Alphaを開く']])('opening an app still navigates in %s',async(locale,label)=>{
 const storage=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)})
 vi.stubGlobal('location',{hash:'#/apps',search:''});vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),visibilityState:'visible',documentElement:{lang:''}})
 state.pins=[];state.api={apps:vi.fn().mockResolvedValue({apps:[{id:'a',name:'Alpha',description:'Test',icon:'grid',channels:[]}]}),templates:vi.fn().mockResolvedValue({templates:[]}),app:vi.fn(()=>new Promise(()=>{})),personalViews:vi.fn(()=>new Promise(()=>{})),conversation:vi.fn().mockResolvedValue({messages:[],annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]})}
 changeLocale(locale);await localeReady();let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<HarnessApps httpBase="https://example.invalid" orgId="team:one" sessionToken="test" onClose={()=>{}}/>);await Promise.resolve()})
 await act(async()=>tree!.root.findByProps({'aria-label':label}).props.onClick());expect(location.hash).toBe('#/apps/a/team%3Aone?section=data');act(()=>tree!.unmount())
})

test.each([['en','Open Alpha $&','Pin Alpha $& to navigation'],['ja','Alpha $&を開く','Alpha $&をナビゲーションに固定']])('app names containing replacement characters are preserved in %s labels',async(locale,openLabel,pinLabel)=>{
 const storage=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)})
 vi.stubGlobal('location',{hash:'#/apps',search:''});state.pins=[]
 state.api={apps:vi.fn().mockResolvedValue({apps:[{id:'a',name:'Alpha $&',description:'Test',icon:'grid',channels:[]}]}),templates:vi.fn().mockResolvedValue({templates:[]})}
 changeLocale(locale);await localeReady();let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<HarnessApps httpBase="https://example.invalid" orgId="team:one" sessionToken="test" onClose={()=>{}}/>);await Promise.resolve()})
 expect(tree!.root.findByProps({'aria-label':openLabel})).toBeTruthy();expect(tree!.root.findByProps({'aria-label':pinLabel})).toBeTruthy();act(()=>tree!.unmount())
})
