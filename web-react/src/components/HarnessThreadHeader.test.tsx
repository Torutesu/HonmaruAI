import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {HarnessThreadHeader} from './HarnessThreadHeader'
import {RowMenu} from './RowMenu'
vi.mock('../utils/useThreadNotifications',()=>({useThreadNotifications:()=>({muted:false,busy:false,error:'',toggle:()=>{}})}))
vi.mock('./RowMenu',()=>({RowMenu:()=>null}))
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
const api={httpBase:'https://api.example',orgId:'team:test',sessionToken:'token'}
const parent:any={id:'root',body:'Original request',threadTitle:'Title',threadTitleVersion:1,canRenameThread:true}
const ok=(value:any,status=200)=>({ok:status===200,status,json:async()=>value})
function globals(){vi.stubGlobal('window',{dispatchEvent:vi.fn()});vi.stubGlobal('CustomEvent',class{constructor(public type:string,public detail:any){}})}
afterEach(()=>vi.unstubAllGlobals())
function begin(tree:ReturnType<typeof create>){act(()=>tree.root.findByProps({'aria-label':'その他のスレッド操作'}).props.onClick({currentTarget:{getBoundingClientRect:()=>({left:0,bottom:0})}}));act(()=>tree.root.findByType(RowMenu).props.entries.find((entry:any)=>entry.label==='スレッド名を変更').onSelect())}
const button=(tree:ReturnType<typeof create>,label:string)=>tree.root.findAllByType('button').find(node=>node.children.includes(label))!
test('rename preserves the original message and submits the version captured when editing began',async()=>{
 globals();const onParent=vi.fn(),fetch=vi.fn().mockResolvedValue(ok({parent:{...parent,threadTitle:'New title',threadTitleVersion:2}}));vi.stubGlobal('fetch',fetch)
 let tree:ReturnType<typeof create>;act(()=>{tree=create(<HarnessThreadHeader api={api} channel="b:general" parent={parent} room="general" onClose={()=>{}} onParent={onParent}/>)})
 begin(tree!);act(()=>tree!.root.findByType('input').props.onChange({target:{value:'New title'}}))
 await act(async()=>button(tree!,'保存').props.onClick())
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({orgId:'team:test',channel:'b:general',messageId:'root',title:'New title',version:1})
 expect(onParent.mock.calls[0][0].body).toBe('Original request');expect(tree!.root.findAllByType('input')).toHaveLength(0);act(()=>tree!.unmount())
})
test('conflicts retain the draft and require reading the latest version before retrying',async()=>{
 globals();const fetch=vi.fn().mockResolvedValueOnce(ok({},409)).mockResolvedValueOnce(ok({parent:{...parent,threadTitle:'Other device',threadTitleVersion:4}})).mockResolvedValueOnce(ok({parent:{...parent,threadTitle:'My draft',threadTitleVersion:5}}));vi.stubGlobal('fetch',fetch)
 let tree:ReturnType<typeof create>;act(()=>{tree=create(<HarnessThreadHeader api={api} channel="b:general" parent={parent} room="general" onClose={()=>{}} onParent={()=>{}}/>)})
 begin(tree!);act(()=>tree!.root.findByType('input').props.onChange({target:{value:'My draft'}}))
 await act(async()=>button(tree!,'保存').props.onClick());expect(button(tree!,'保存').props.disabled).toBe(true);expect(tree!.root.findByType('input').props.value).toBe('My draft')
 await act(async()=>button(tree!,'最新の名前を確認').props.onClick());expect(tree!.root.findByType('input').props.value).toBe('My draft');expect(new URL(fetch.mock.calls[1][0]).searchParams.get('limit')).toBe('50')
 await act(async()=>button(tree!,'保存').props.onClick());expect(JSON.parse(fetch.mock.calls[2][1].body).version).toBe(4);act(()=>tree!.unmount())
})
test('a save resolving after leaving the thread does not update another screen',async()=>{
 globals();let resolve!:(value:any)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(r=>resolve=r)));const onParent=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<HarnessThreadHeader api={api} channel="b:general" parent={parent} room="general" onClose={()=>{}} onParent={onParent}/>)})
 begin(tree!);act(()=>button(tree!,'保存').props.onClick());act(()=>tree!.unmount())
 await act(async()=>resolve(ok({parent:{...parent,threadTitle:'Late'}})));expect(onParent).not.toHaveBeenCalled()
})

test('thread copy excludes login query parameters and shows the link when clipboard access fails',async()=>{
 globals();vi.stubGlobal('location',{origin:'https://app.example',pathname:'/',search:'?code=secret'});const writeText=vi.fn().mockRejectedValue(new Error('denied'));vi.stubGlobal('navigator',{clipboard:{writeText}})
 let tree:ReturnType<typeof create>;act(()=>{tree=create(<HarnessThreadHeader api={api} channel="b:general" parent={parent} room="general" onClose={()=>{}} onParent={()=>{}}/>)})
 await act(async()=>tree!.root.findByProps({'aria-label':'スレッドのリンクをコピー'}).props.onClick())
 expect(writeText).toHaveBeenCalledWith('https://app.example/#/t/root/team%3Atest');expect(tree!.root.findByProps({'aria-label':'スレッドのリンク'}).props.value).toBe('https://app.example/#/t/root/team%3Atest')
 expect(JSON.stringify(tree!.toJSON())).toContain('コピーできませんでした');act(()=>tree!.unmount())
})
