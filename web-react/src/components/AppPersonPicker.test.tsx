import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppRecordDialog} from './AppRecordDialog'
vi.mock('./Dialog',()=>({Dialog:({children,footer,onClose}:any)=><div><button onClick={onClose}>閉じる</button>{children}{footer}</div>}))
afterEach(()=>vi.unstubAllGlobals())

function stubBrowserGlobals(){
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 vi.stubGlobal('window',{innerWidth:1280,innerHeight:800,addEventListener:vi.fn(),removeEventListener:vi.fn()})
}

test('person fields search workspace members, select by keyboard and submit the stable reference',async()=>{
 stubBrowserGlobals()
 const members=[...Array.from({length:8},(_,i)=>({ref:`user_${i+1}`,name:`Member ${i+1}`})),{ref:'mika',name:'Mika'}]
 const save=vi.fn().mockResolvedValue(undefined);let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={[{id:'owner',name:'担当者',type:'person'}]} members={members} save={save} onClose={()=>{}}/>)});
 const trigger=tree!.root.findByProps({role:'combobox', 'aria-label':'担当者'})
 act(()=>trigger.props.onClick())
 const search=tree!.root.findByProps({'aria-label':'メンバーを検索'})
 act(()=>search.props.onChange({target:{value:'Mika'}}))
 expect(tree!.root.findAllByProps({role:'option'}).map(option=>option.props['data-member-ref'])).toEqual(['','mika'])
 const updatedSearch=tree!.root.findByProps({'aria-label':'メンバーを検索'})
 act(()=>updatedSearch.props.onKeyDown({key:'ArrowDown',nativeEvent:{isComposing:false},preventDefault:vi.fn()}))
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onKeyDown({key:'Enter',nativeEvent:{isComposing:false},preventDefault:vi.fn()}))
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})})
 expect(save).toHaveBeenCalledWith({owner:'mika'});act(()=>tree!.unmount())
})

test('person fields fail closed while members are unavailable and retain legacy values',()=>{
 stubBrowserGlobals()
 let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={[{id:'owner',name:'担当者',type:'person'}]} initial={{owner:'former-member'}} members={[]} membersReady={false} save={vi.fn()} onClose={()=>{}}/>)});
 const trigger=tree!.root.findByProps({role:'combobox', 'aria-label':'担当者'})
 expect(trigger.props.disabled).toBe(true);expect(trigger.findAllByType('span').map(span=>span.children.join(''))).toContain('former-member')
 act(()=>tree!.unmount())
})
