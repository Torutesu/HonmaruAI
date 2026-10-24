import React from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {FloatingAppWorkspace} from './FloatingAppWorkspace'
import {useFloatingApp} from './FloatingAppContext'
vi.mock('../screens/Harness',()=>({AppView:(props:any)=><div data-app={props.appId}><button onClick={()=>props.onSectionChange('settings')}>Settings</button><button onClick={props.onBack}>Dock</button><button onClick={props.onClose}>Close</button></div>}))
vi.mock('../utils/harness',()=>({harnessApi:(base:string,org:string,session:string)=>({base,org,session})}))
let tree:ReactTestRenderer
beforeEach(()=>{vi.stubGlobal('innerWidth',1200);vi.stubGlobal('innerHeight',800);vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal('location',{hash:'#/list'})})
afterEach(()=>{if(tree)act(()=>tree.unmount());vi.unstubAllGlobals()})
function Launcher(){const open=useFloatingApp();return <button disabled={!open} onClick={()=>open?.('test_app','data')}>Float</button>}
function view(org='team:one',session='one',enabled=true){return <FloatingAppWorkspace httpBase="https://api" orgId={org} sessionToken={session} enabled={enabled}><Launcher/><input defaultValue="Conversation draft"/></FloatingAppWorkspace>}
const button=(label:string)=>tree.root.findAllByType('button').find(node=>node.props.children===label)!
const regions=()=>tree.root.findAllByProps({role:'region'})
test('keeps underlying conversation mounted, supports keyboard movement and returns current section',()=>{
 act(()=>{tree=create(view())});const input=tree.root.findByType('input')
 act(()=>button('Float').props.onClick());expect(regions()).toHaveLength(1);expect(tree.root.findByType('input')).toBe(input)
 const root=regions()[0],target={};act(()=>root.props.onKeyDown({target,currentTarget:target,key:'ArrowLeft',shiftKey:false,preventDefault:vi.fn()}))
 expect(regions()[0].props.style.left).toBe(692)
 act(()=>button('Settings').props.onClick());act(()=>button('Dock').props.onClick())
 expect(location.hash).toBe('#/apps/test_app/team%3Aone?section=settings');expect(regions()).toHaveLength(0)
})
test('removes floating content on workspace, credential and simple-mode transitions',()=>{
 act(()=>{tree=create(view())});act(()=>button('Float').props.onClick())
 act(()=>tree.update(view('team:two')));expect(regions()).toHaveLength(0)
 act(()=>button('Float').props.onClick());act(()=>tree.update(view('team:two','changed')));expect(regions()).toHaveLength(0)
 act(()=>button('Float').props.onClick());act(()=>tree.update(view('team:two','changed',false)));expect(regions()).toHaveLength(0);expect(button('Float').props.disabled).toBe(true)
 act(()=>tree.update(view('team:one')));expect(regions()).toHaveLength(0)
})
