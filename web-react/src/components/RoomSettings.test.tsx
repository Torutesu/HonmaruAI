import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {RoomSettings} from './RoomSettings'
import {Dialog} from './Dialog'
vi.mock('./Dialog',()=>({Dialog:({children,footer}:any)=><section>{children}{footer}</section>}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
const api={httpBase:'https://relay.test',orgId:'org',sessionToken:'token'}
const settings={name:'Planning',color:'teal',mentionedOnly:false,version:4,responseVersion:2}
const reply=(body:any,status=200)=>({ok:status<400,status,json:async()=>body})
const loaded=(overrides={})=>reply({settings,canEdit:true,canChangeResponses:true,...overrides})
const find=(tree:ReturnType<typeof create>,name:string)=>tree.root.findAllByType('button').find(n=>n.children.includes(name))!
afterEach(()=>vi.unstubAllGlobals())
test('loads authoritative settings and saves all fields with the reviewed versions',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(loaded()).mockResolvedValueOnce(reply({settings:{...settings,name:'Changed',color:'lake',mentionedOnly:true,version:5,responseVersion:3}}));vi.stubGlobal('fetch',fetcher)
 const close=vi.fn(),saved=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomSettings api={api} view="b:room" onClose={close} onSaved={saved}/>)})
 expect(find(tree,'Save').props.disabled).toBe(true)
 act(()=>tree.root.findByProps({'aria-label':'Room name'}).props.onChange({target:{value:' Changed '}}))
 act(()=>tree.root.findByProps({className:'room-create-color'}).props.onClick())
 act(()=>tree.root.findByProps({'aria-label':'Lake'}).props.onClick())
 act(()=>tree.root.findByProps({role:'switch'}).props.onChange({target:{checked:true}}))
 await act(async()=>find(tree,'Save').props.onClick())
 expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({orgId:'org',channel:'b:room',name:'Changed',color:'lake',mentionedOnly:true,version:4,responseVersion:2})
 expect(saved).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();act(()=>tree.unmount())
})
test('pending save prevents duplicate submission and dismissing the dialog',async()=>{
 let finish!:(value:any)=>void;const fetcher=vi.fn().mockResolvedValueOnce(loaded()).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));vi.stubGlobal('fetch',fetcher)
 const close=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomSettings api={api} view="b:room" onClose={close} onSaved={vi.fn()}/>)})
 act(()=>tree.root.findByProps({'aria-label':'Room name'}).props.onChange({target:{value:'Pending'}}))
 const save=find(tree,'Save').props.onClick;act(()=>{save();save();tree.root.findByType(Dialog).props.onClose()})
 expect(fetcher).toHaveBeenCalledTimes(2);expect(close).not.toHaveBeenCalled();expect(find(tree,'Cancel').props.disabled).toBe(true)
 await act(async()=>finish(reply({message:'Network failed'},503)))
 expect(tree.root.findByProps({'aria-label':'Room name'}).props.value).toBe('Pending')
 expect(find(tree,'Save').props.disabled).toBe(false);act(()=>tree.unmount())
})
test('conflict keeps the draft and requires explicit reload before another save',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(loaded()).mockResolvedValueOnce(reply({message:'Room settings changed. Reload before saving.'},409)).mockResolvedValueOnce(loaded({settings:{...settings,name:'Other member',version:5}}));vi.stubGlobal('fetch',fetcher)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomSettings api={api} view="b:room" onClose={vi.fn()} onSaved={vi.fn()}/>)})
 act(()=>tree.root.findByProps({'aria-label':'Room name'}).props.onChange({target:{value:'My draft'}}))
 await act(async()=>find(tree,'Save').props.onClick())
 expect(tree.root.findByProps({'aria-label':'Room name'}).props.value).toBe('My draft');expect(find(tree,'Save').props.disabled).toBe(true)
 await act(async()=>find(tree,'Reload latest settings').props.onClick())
 expect(tree.root.findByProps({'aria-label':'Room name'}).props.value).toBe('Other member');act(()=>tree.unmount())
})
test('read-only visitors and response permissions are reflected independently',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(loaded({canEdit:false,canChangeResponses:false})).mockResolvedValueOnce(loaded({canChangeResponses:false})))
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomSettings api={api} view="b:room" onClose={vi.fn()} onSaved={vi.fn()}/>)})
 expect(tree.root.findByProps({'aria-label':'Room name'}).props.disabled).toBe(true);expect(tree.root.findByProps({role:'switch'}).props.disabled).toBe(true)
 await act(async()=>tree.update(<RoomSettings api={api} view="b:other" onClose={vi.fn()} onSaved={vi.fn()}/>))
 expect(tree.root.findByProps({'aria-label':'Room name'}).props.disabled).toBe(false);expect(tree.root.findByProps({role:'switch'}).props.disabled).toBe(true);act(()=>tree.unmount())
})
test('late reads and saves cannot apply to another room or a closed dialog',async()=>{
 let finishRead!:(value:any)=>void,finishSave!:(value:any)=>void
 const fetcher=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finishRead=resolve})).mockResolvedValueOnce(loaded({settings:{...settings,name:'Second'}})).mockImplementationOnce(()=>new Promise(resolve=>{finishSave=resolve}));vi.stubGlobal('fetch',fetcher)
 const close=vi.fn(),saved=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomSettings api={api} view="b:first" onClose={close} onSaved={saved}/>)})
 await act(async()=>tree.update(<RoomSettings api={api} view="b:second" onClose={close} onSaved={saved}/>))
 await act(async()=>finishRead(loaded()))
 expect(tree.root.findByProps({'aria-label':'Room name'}).props.value).toBe('Second')
 act(()=>tree.root.findByProps({'aria-label':'Room name'}).props.onChange({target:{value:'Save second'}}))
 act(()=>find(tree,'Save').props.onClick());act(()=>tree.unmount())
 await act(async()=>finishSave(reply({settings})))
 expect(close).not.toHaveBeenCalled();expect(saved).not.toHaveBeenCalled()
})
test('failed loading exposes retry and never enables saving guessed values',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(loaded()))
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomSettings api={api} view="b:room" onClose={vi.fn()} onSaved={vi.fn()}/>)})
 expect(find(tree,'Save').props.disabled).toBe(true);expect(tree.root.findByProps({role:'alert'}).children).toContain('Offline')
 await act(async()=>find(tree,'Reload latest settings').props.onClick())
 expect(tree.root.findByProps({'aria-label':'Room name'}).props.value).toBe('Planning');act(()=>tree.unmount())
})

test('switching rooms releases the old save without allowing it to unlock the next save',async()=>{
 let finishFirst!:(value:any)=>void,finishSecond!:(value:any)=>void
 const fetcher=vi.fn().mockResolvedValueOnce(loaded()).mockImplementationOnce(()=>new Promise(resolve=>{finishFirst=resolve})).mockResolvedValueOnce(loaded({settings:{...settings,name:'Second'}})).mockImplementationOnce(()=>new Promise(resolve=>{finishSecond=resolve}))
 vi.stubGlobal('fetch',fetcher)
 const close=vi.fn(),saved=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomSettings api={api} view="b:first" onClose={close} onSaved={saved}/>)})
 act(()=>tree.root.findByProps({'aria-label':'Room name'}).props.onChange({target:{value:'First draft'}}))
 act(()=>find(tree,'Save').props.onClick())
 await act(async()=>tree.update(<RoomSettings api={api} view="b:second" onClose={close} onSaved={saved}/>))
 expect(find(tree,'Cancel').props.disabled).toBe(false)
 expect(tree.root.findByProps({'aria-label':'Room name'}).props.disabled).toBe(false)
 act(()=>tree.root.findByProps({'aria-label':'Room name'}).props.onChange({target:{value:'Second draft'}}))
 act(()=>find(tree,'Save').props.onClick())
 await act(async()=>finishFirst(reply({settings})))
 expect(find(tree,'Cancel').props.disabled).toBe(true)
 act(()=>tree.root.findByType(Dialog).props.onClose())
 expect(close).not.toHaveBeenCalled();expect(saved).not.toHaveBeenCalled()
 expect(fetcher).toHaveBeenCalledTimes(4)
 await act(async()=>finishSecond(reply({settings})))
 expect(saved).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce()
 act(()=>tree.unmount())
})
