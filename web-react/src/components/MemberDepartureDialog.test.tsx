import React from 'react'
import {act,create} from 'react-test-renderer'
import {test,expect,vi,afterEach} from 'vitest'
import {MemberDepartureDialog} from './MemberDepartureDialog'
import {Dialog} from './Dialog'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
afterEach(()=>vi.unstubAllGlobals())
const member={ref:'departing',name:'Departing person',mine:true}
const preview={version:'snapshot',member,agents:[{id:'a',name:'Private agent',owned:true,scope:'personal',version:0}],candidates:[{ref:'successor',name:'Successor'}]}
const response=(body:unknown,ok=true)=>({ok,json:async()=>body})
test('departure requires an explicit successor, keeps failed selection, and sends the reviewed version',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(preview)))
 const remove=vi.fn().mockRejectedValue(Error('Workspace responsibilities changed. Reload before removing this member.'))
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<MemberDepartureDialog httpBase="https://example.test" orgId="team" sessionToken="test" member={member} onRemove={remove} onClose={vi.fn()}/>)})
 const button=()=>tree.root.findAllByType('button').find(n=>n.children.includes('Leave'))!
 expect(button().props.disabled).toBe(true)
 act(()=>tree.root.findByType('select').props.onChange({target:{value:'successor'}}))
 expect(remove).not.toHaveBeenCalled()
 await act(async()=>button().props.onClick())
 expect(remove).toHaveBeenCalledWith({previewVersion:'snapshot',transferTo:'successor'})
 expect(tree.root.findByType('select').props.value).toBe('successor')
 expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('Reload')
 act(()=>tree.unmount())
})
test('a failed preview never enables removal and reload recovers without a transfer field when there are no agents',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(response({message:'No permission'},false)).mockResolvedValue(response({...preview,agents:[]}))
 vi.stubGlobal('fetch',fetch);const remove=vi.fn().mockResolvedValue(undefined);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<MemberDepartureDialog httpBase="https://example.test" orgId="team" sessionToken="test" member={member} onRemove={remove} onClose={vi.fn()}/>)})
 const button=(label:string)=>tree.root.findAllByType('button').find(n=>n.children.includes(label))!
 expect(button('Leave').props.disabled).toBe(true)
 await act(async()=>button('Reload').props.onClick())
 expect(tree.root.findAllByType('select')).toHaveLength(0)
 await act(async()=>button('Leave').props.onClick())
 expect(remove).toHaveBeenCalledWith({previewVersion:'snapshot'})
 act(()=>tree.unmount())
})

test('a pending departure cannot be submitted twice or closed',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(preview)))
 let finish!:()=>void
 const remove=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve})),close=vi.fn()
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<MemberDepartureDialog httpBase="https://example.test" orgId="team" sessionToken="test" member={member} onRemove={remove} onClose={close}/>)})
 act(()=>tree.root.findByType('select').props.onChange({target:{value:'successor'}}))
 const click=tree.root.findAllByType('button').find(n=>n.children.includes('Leave'))!.props.onClick
 act(()=>{click();click()})
 expect(remove).toHaveBeenCalledTimes(1)
 expect(tree.root.findAllByType('button').every(n=>n.props.disabled)).toBe(true)
 expect(tree.root.findByType('select').props.disabled).toBe(true)
 act(()=>tree.root.findByType(Dialog).props.onClose())
 expect(close).not.toHaveBeenCalled()
 await act(async()=>finish())
 expect(close).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})

test('late responses for a different member cannot replace the current preview',async()=>{
 let resolveOld!:(value:unknown)=>void
 const next={...member,ref:'other',name:'Other member'}
 const fetch=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve})).mockResolvedValue(response({...preview,member:next,agents:[]}))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 const remove=vi.fn(),close=vi.fn()
 await act(async()=>{tree=create(<MemberDepartureDialog httpBase="https://example.test" orgId="team" sessionToken="test" member={member} onRemove={remove} onClose={close}/>)})
 await act(async()=>tree.update(<MemberDepartureDialog httpBase="https://example.test" orgId="team" sessionToken="test" member={next} onRemove={remove} onClose={close}/>))
 await act(async()=>resolveOld(response(preview)))
 expect(tree.root.findAllByType('select')).toHaveLength(0)
 expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
 act(()=>tree.unmount())
})

test('a skill-only departure still requires a successor',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({...preview,agents:[],skills:[{id:'skill',name:'Private method',visibility:'private',version:1}]})))
 const remove=vi.fn().mockResolvedValue(undefined);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<MemberDepartureDialog httpBase="https://example.test" orgId="team" sessionToken="test" member={member} onRemove={remove} onClose={vi.fn()}/>)})
 const button=()=>tree.root.findAllByType('button').find(n=>n.children.includes('Leave'))!
 expect(button().props.disabled).toBe(true)
 expect(tree.root.findAllByType('summary')[0].children).toContain('Custom skills')
 act(()=>tree.root.findByType('select').props.onChange({target:{value:'successor'}}))
 await act(async()=>button().props.onClick())
 expect(remove).toHaveBeenCalledWith({previewVersion:'snapshot',transferTo:'successor'})
 act(()=>tree.unmount())
})
