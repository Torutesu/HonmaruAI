import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppRecordDialog} from './AppRecordDialog'
import {AppPersonPicker} from './AppPersonPicker'
import {Avatar} from './Avatar'
vi.mock('./Dialog',()=>({Dialog:({children,footer,onClose}:any)=><div><button onClick={onClose}>閉じる</button>{children}{footer}</div>}))
afterEach(()=>vi.unstubAllGlobals())

function stubBrowserGlobals(){
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 vi.stubGlobal('window',{innerWidth:1280,innerHeight:800,addEventListener:vi.fn(),removeEventListener:vi.fn()})
}

test('person fields search workspace members, select by keyboard and submit the stable reference',async()=>{
 stubBrowserGlobals()
 const members=[...Array.from({length:8},(_,i)=>({ref:`user_${i+1}`,name:`Member ${i+1}`,...(i===0?{avatarUrl:'https://avatars.example/user1.png'}:{})})),{ref:'mika',name:'Mika'}]
 const save=vi.fn().mockResolvedValue(undefined);let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={[{id:'owner',name:'担当者',type:'person'}]} members={members} save={save} onClose={()=>{}}/>)});
 const trigger=tree!.root.findByProps({role:'combobox', 'aria-label':'担当者'})
 act(()=>trigger.props.onClick())
 expect(tree!.root.findAllByType(Avatar).some(avatar=>avatar.props.url==='https://avatars.example/user1.png')).toBe(true)
 const search=tree!.root.findByProps({'aria-label':'メンバーを検索'})
 act(()=>search.props.onChange({target:{value:'Mika'}}))
 expect(tree!.root.findAllByProps({role:'option'}).map(option=>option.props['data-member-ref'])).toEqual(['','mika'])
 const updatedSearch=tree!.root.findByProps({'aria-label':'メンバーを検索'})
 act(()=>updatedSearch.props.onKeyDown({key:'Enter',nativeEvent:{isComposing:false},preventDefault:vi.fn()}))
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})})
 expect(save).toHaveBeenCalledWith({owner:'mika'});act(()=>tree!.unmount())
})

test('an unmatched search does not clear an existing assignee, while clear is explicit',async()=>{
 stubBrowserGlobals()
 const save=vi.fn().mockResolvedValue(undefined);let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={[{id:'owner',name:'担当者',type:'person'}]} record={{id:'r',values:{owner:'alice'},createdAt:'2025-01-01',updatedAt:'2025-01-01'}} members={[{ref:'alice',name:'Alice'},{ref:'bob',name:'Bob'}]} save={save} onClose={()=>{}}/>)});
 act(()=>tree!.root.findByProps({role:'combobox'}).props.onClick())
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onChange({target:{value:'missing'}}))
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onKeyDown({key:'Enter',nativeEvent:{},preventDefault:vi.fn()}))
 expect(tree!.root.findByProps({role:'combobox'}).props['aria-expanded']).toBe(true)
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})})
 expect(save).toHaveBeenLastCalledWith({})
 act(()=>tree!.root.findByProps({role:'combobox'}).props.onClick())
 act(()=>tree!.root.findByProps({role:'option','data-member-ref':''}).props.onClick())
 await act(async()=>{await tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})})
 expect(save).toHaveBeenLastCalledWith({owner:null});act(()=>tree!.unmount())
})

test('reopening after a search preserves the selected person and navigation tracks identity',()=>{
 stubBrowserGlobals()
 const onChange=vi.fn();let tree:ReturnType<typeof create>
 const members=[{ref:'alice',name:'Alice'},{ref:'bob',name:'Bob'},{ref:'bobby',name:'Bobby'}]
 const view=(list:typeof members)=><AppPersonPicker label="担当者" value="alice" members={list} onChange={onChange}/>
 act(()=>{tree=create(view(members))});act(()=>tree!.root.findByProps({role:'combobox'}).props.onClick())
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onChange({target:{value:'Bob'}}))
 expect(tree!.root.findByProps({role:'option','data-member-ref':'bob'}).props.className).toBe('active')
 act(()=>tree!.update(view([members[2],members[1],members[0]])))
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onKeyDown({key:'Enter',nativeEvent:{},preventDefault:vi.fn()}))
 expect(onChange).toHaveBeenLastCalledWith('bob')
 act(()=>tree!.root.findByProps({role:'combobox'}).props.onClick())
 expect(tree!.root.findByProps({role:'option','data-member-ref':'alice'}).props.className).toBe('active')
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onChange({target:{value:'Bob'}}))
 act(()=>tree!.update(view([members[0],members[1]])))
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onKeyDown({key:'Enter',nativeEvent:{},preventDefault:vi.fn()}))
 expect(onChange).toHaveBeenCalledTimes(1);act(()=>tree!.unmount())
})

test('IME Enter and navigation do not select; Home explicitly selects unassigned',()=>{
 stubBrowserGlobals();const onChange=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppPersonPicker label="担当者" value="alice" members={[{ref:'alice',name:'Alice'},{ref:'bob',name:'Bob'}]} onChange={onChange}/>)});
 act(()=>tree!.root.findByProps({role:'combobox'}).props.onClick())
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onChange({target:{value:'Bob'}}))
 for(const event of [{key:'Enter',nativeEvent:{isComposing:true}},{key:'Enter',nativeEvent:{keyCode:229}},{key:'Home',nativeEvent:{keyCode:229}}])act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onKeyDown({...event,preventDefault:vi.fn()}))
 expect(onChange).not.toHaveBeenCalled();expect(tree!.root.findByProps({role:'option','data-member-ref':'bob'}).props.className).toBe('active')
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onKeyDown({key:'Home',nativeEvent:{},preventDefault:vi.fn()}))
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onKeyDown({key:'Enter',nativeEvent:{},preventDefault:vi.fn()}))
 expect(onChange).toHaveBeenCalledWith('');act(()=>tree!.unmount())
})

test('matching duplicate names remain distinguishable by reference and arrow selection',()=>{
 stubBrowserGlobals();const onChange=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppPersonPicker label="担当者" value="alice" members={[{ref:'alice',name:'Alice'},{ref:'first',name:'Sam'},{ref:'second',name:'Sam'}]} onChange={onChange}/>)});
 act(()=>tree!.root.findByProps({role:'combobox'}).props.onClick())
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onChange({target:{value:'Sam'}}))
 expect(tree!.root.findByProps({role:'option','data-member-ref':'first'}).props.className).toBe('active')
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onKeyDown({key:'ArrowDown',nativeEvent:{},preventDefault:vi.fn()}))
 expect(tree!.root.findByProps({role:'option','data-member-ref':'second'}).props.className).toBe('active')
 act(()=>tree!.root.findByProps({'aria-label':'メンバーを検索'}).props.onKeyDown({key:'Enter',nativeEvent:{},preventDefault:vi.fn()}))
 expect(onChange).toHaveBeenCalledWith('second');act(()=>tree!.unmount())
})

test('Escape during IME leaves the picker open; ordinary Escape closes it',()=>{
 const handlers=new Map<string,EventListener>();const focus=vi.fn()
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 vi.stubGlobal('window',{innerWidth:1280,innerHeight:800,addEventListener:vi.fn((name:string,fn:EventListener)=>handlers.set(name,fn)),removeEventListener:vi.fn()})
 let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppPersonPicker label="担当者" value="alice" members={[{ref:'alice',name:'Alice'}]} onChange={vi.fn()}/>,{createNodeMock:node=>node.type==='div'?{contains:()=>true}:node.type==='button'?{focus,getBoundingClientRect:()=>({width:200,left:0,top:0,bottom:20})}:null})})
 act(()=>tree!.root.findByProps({role:'combobox'}).props.onClick())
 const keydown=handlers.get('keydown')!
 for(const marker of [{isComposing:true},{keyCode:229}])act(()=>keydown({key:'Escape',target:{},preventDefault:vi.fn(),stopImmediatePropagation:vi.fn(),...marker} as unknown as Event))
 expect(tree!.root.findByProps({role:'combobox'}).props['aria-expanded']).toBe(true)
 act(()=>keydown({key:'Escape',target:{},preventDefault:vi.fn(),stopImmediatePropagation:vi.fn()} as unknown as Event))
 expect(tree!.root.findByProps({role:'combobox'}).props['aria-expanded']).toBe(false);expect(focus).toHaveBeenCalled();act(()=>tree!.unmount())
})

test('person fields fail closed while members are unavailable and retain legacy values',()=>{
 stubBrowserGlobals()
 let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={[{id:'owner',name:'担当者',type:'person'}]} initial={{owner:'former-member'}} members={[]} membersReady={false} save={vi.fn()} onClose={()=>{}}/>)});
 const trigger=tree!.root.findByProps({role:'combobox', 'aria-label':'担当者'})
 expect(trigger.props.disabled).toBe(true);expect(trigger.findAllByType('span').map(span=>span.children.join(''))).toContain('former-member')
 act(()=>tree!.unmount())
})

test('keeps the Kylon-style member search visible in small workspaces',()=>{
 stubBrowserGlobals()
 let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="タスク" columns={[{id:'owner',name:'担当者',type:'person'}]} members={[{ref:'user_1',name:'Tano Toru'},{ref:'user_2',name:'Aris'}]} save={vi.fn()} onClose={()=>{}}/>)});
 act(()=>tree!.root.findByProps({role:'combobox','aria-label':'担当者'}).props.onClick())
 expect(tree!.root.findByProps({'aria-label':'メンバーを検索'})).toBeTruthy()
 expect(tree!.root.findAllByProps({role:'option'}).map(option=>option.props['data-member-ref'])).toEqual(['','user_1','user_2'])
 act(()=>tree!.unmount())
})
