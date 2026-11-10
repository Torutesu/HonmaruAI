import React from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {FloatingAppWorkspace} from './FloatingAppWorkspace'
import {useFloatingApp} from './FloatingAppContext'
vi.mock('../screens/Harness',()=>({AppView:(props:any)=><div data-app={props.appId} data-initial-section={props.initialSection}><button onClick={()=>props.onSectionChange('settings')}>Settings</button><button onClick={props.onBack}>Dock</button><button onClick={props.onClose}>Close</button></div>}))
vi.mock('../utils/harness',()=>({harnessApi:(base:string,org:string,session:string)=>({base,org,session})}))
let tree:ReactTestRenderer
beforeEach(()=>{vi.stubGlobal('innerWidth',1200);vi.stubGlobal('innerHeight',800);vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal('location',{hash:'#/list'})})
afterEach(()=>{if(tree)act(()=>tree.unmount());vi.unstubAllGlobals()})
function Launcher(){const open=useFloatingApp();return <button disabled={!open} onClick={()=>open?.('test_app','data')}>Float</button>}
function view(org='team:one',session='one',enabled=true,interactive=true,userId='person:one'){return <FloatingAppWorkspace httpBase="https://api" orgId={org} userId={userId} sessionToken={session} enabled={enabled} interactive={interactive}><Launcher/><input defaultValue="Conversation draft"/></FloatingAppWorkspace>}
const button=(label:string)=>tree.root.findAllByType('button').find(node=>node.props.children===label)!
const regions=()=>tree.root.findAllByProps({role:'region'})
test('keeps underlying conversation mounted, supports keyboard movement and returns current section',()=>{
 act(()=>{tree=create(view())});const input=tree.root.findByType('input')
 act(()=>button('Float').props.onClick());expect(regions()).toHaveLength(1);expect(tree.root.findByType('input')).toBe(input)
 const root=regions()[0],target={};act(()=>root.props.onKeyDown({target,currentTarget:target,key:'ArrowLeft',shiftKey:false,preventDefault:vi.fn()}))
 expect(regions()[0].props.style.left).toBe(692)
 act(()=>button('Settings').props.onClick());expect(tree.root.findByProps({'data-app':'test_app'}).props['data-initial-section']).toBe('data');act(()=>button('Dock').props.onClick())
 expect(location.hash).toBe('#/apps/test_app/team%3Aone?section=settings');expect(regions()).toHaveLength(0)
})
test('removes floating content on workspace, credential and simple-mode transitions',()=>{
 act(()=>{tree=create(view())});act(()=>button('Float').props.onClick())
 act(()=>tree.update(view('team:two')));expect(regions()).toHaveLength(0)
 act(()=>button('Float').props.onClick());act(()=>tree.update(view('team:two','changed')));expect(regions()).toHaveLength(0)
 act(()=>button('Float').props.onClick());act(()=>tree.update(view('team:two','changed',false)));expect(regions()).toHaveLength(0);expect(button('Float').props.disabled).toBe(true)
 act(()=>tree.update(view('team:one')));expect(regions()).toHaveLength(0)
})

test('covering the floating app suspends interaction without losing its section or geometry',()=>{
 const node={toggleAttribute:vi.fn(),focus:vi.fn()}
 act(()=>{tree=create(view(),{createNodeMock:element=>element.props.className==='hx-floating-app'?node:null})})
 act(()=>button('Float').props.onClick());act(()=>button('Settings').props.onClick())
 const before=regions()[0].props.style
 act(()=>tree.update(view('team:one','one',true,false)))
 expect(node.toggleAttribute).toHaveBeenLastCalledWith('inert',true);expect(regions()[0].props.style).toEqual(before)
 act(()=>tree.update(view()))
 expect(node.toggleAttribute).toHaveBeenLastCalledWith('inert',false)
 act(()=>button('Dock').props.onClick());expect(location.hash).toContain('section=settings')
})

test('mode discovery preserves the underlying editor while resetting floating content',()=>{
 act(()=>{tree=create(view('team:one','one',false))});const input=tree.root.findByType('input')
 act(()=>tree.update(view()));expect(tree.root.findByType('input')).toBe(input)
 act(()=>button('Float').props.onClick())
 act(()=>tree.update(view('team:one','one',false)))
 expect(tree.root.findByType('input')).toBe(input);expect(regions()).toHaveLength(0)
})

test('remembers explicit floating placement after close and reopen for the same account only',()=>{
 const values=new Map<string,string>()
 vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>{values.set(key,value)}})
 act(()=>{tree=create(view())});act(()=>button('Float').props.onClick())
 const root=regions()[0],target={}
 act(()=>root.props.onKeyDown({target,currentTarget:target,key:'ArrowLeft',shiftKey:false,preventDefault:vi.fn()}))
 act(()=>root.props.onKeyDown({target,currentTarget:target,key:'ArrowRight',shiftKey:true,preventDefault:vi.fn()}))
 const saved={...regions()[0].props.style}
 expect(saved.left).toBe(692);expect(saved.width).toBe(496)
 act(()=>button('Close').props.onClick());act(()=>button('Float').props.onClick())
 expect(regions()[0].props.style).toEqual(saved)
 act(()=>tree.update(view('team:one','other-token',true,true,'person:two')))
 expect(regions()).toHaveLength(0);act(()=>button('Float').props.onClick())
 expect(regions()[0].props.style).not.toEqual(saved)
})

test('Escape closes the floating pane and restores focus to its launcher',async()=>{
 const launcher={focus:vi.fn(),isConnected:true,hasAttribute:vi.fn(()=>false)}
 vi.stubGlobal('document',{activeElement:launcher})
 act(()=>{tree=create(view())});act(()=>button('Float').props.onClick())
 const root=regions()[0],event={target:{},currentTarget:{},key:'Escape',defaultPrevented:false,preventDefault:vi.fn(),stopPropagation:vi.fn()}
 await act(async()=>{root.props.onKeyDown(event);await Promise.resolve()})
 expect(event.preventDefault).toHaveBeenCalledOnce();expect(event.stopPropagation).toHaveBeenCalledOnce()
 expect(regions()).toHaveLength(0);expect(launcher.focus).toHaveBeenCalledWith({preventScroll:true})
})

test('Escape already handled by an inner control does not close the floating pane',()=>{
 act(()=>{tree=create(view())});act(()=>button('Float').props.onClick())
 const root=regions()[0],event={target:{},currentTarget:{},key:'Escape',defaultPrevented:true,preventDefault:vi.fn(),stopPropagation:vi.fn()}
 act(()=>root.props.onKeyDown(event))
 expect(regions()).toHaveLength(1);expect(event.preventDefault).not.toHaveBeenCalled()
})
