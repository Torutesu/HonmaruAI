import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,test,expect,vi} from 'vitest'
import {RoomMembers} from './RoomMembers'
import {RoomMemberPicker,type RoomCandidate} from './RoomMemberPicker'
vi.mock('./RoomMemberPicker',()=>({RoomMemberPicker:(props:any)=>React.createElement('member-picker',props)}))
vi.mock('./RoomMembersDialog',()=>({RoomMembersDialog:(props:any)=>React.createElement('member-dialog',props)}))
const api={httpBase:'https://relay.test',orgId:'one',sessionToken:'session'}
const detail=(version=3)=>({channel:{managed:true,version,canInvite:true},members:{people:[{ref:'person-ref',name:'Reader',roomRole:'member',canChangeRole:true}],agents:[]}})
const response=(data:any,ok=true)=>({ok,json:async()=>data})
afterEach(()=>vi.unstubAllGlobals())
test('role changes use the reviewed version and refresh the members after success',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(detail())).mockResolvedValueOnce(response({version:4})).mockResolvedValueOnce(response(detail(4)))
 vi.stubGlobal('fetch',fetcher);const changed=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomMembers api={api} view="b:room" onClose={vi.fn()} onInvite={vi.fn()} onProfile={vi.fn()} onChanged={changed}/>)})
 const dialog=()=>tree.root.findByType('member-dialog' as any)
 await act(async()=>dialog().props.onRole(dialog().props.members[0],'admin'))
 expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({orgId:'one',channel:'b:room',version:3,kind:'person',id:'person-ref',role:'admin'})
 expect(fetcher.mock.calls[1][0]).toBe('https://relay.test/channels/room-role')
 expect(changed).toHaveBeenCalledTimes(1);expect(fetcher).toHaveBeenCalledTimes(3)
 act(()=>tree.unmount())
})
test('conflicts refresh the displayed version and still surface the failed mutation',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(detail())).mockResolvedValueOnce(response({message:'Room roles changed.'},false)).mockResolvedValueOnce(response(detail(8)))
 vi.stubGlobal('fetch',fetcher);const changed=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomMembers api={api} view="b:room" onClose={vi.fn()} onInvite={vi.fn()} onProfile={vi.fn()} onChanged={changed}/>)})
 const dialog=tree.root.findByType('member-dialog' as any)
 await act(async()=>{await expect(dialog.props.onRole(dialog.props.members[0],'admin')).rejects.toThrow('Room roles changed.')})
 expect(changed).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(3)
 act(()=>tree.unmount())
})
test('a mutation finishing after unmount cannot update or navigate another room',async()=>{
 let complete!:(value:any)=>void
 const fetcher=vi.fn().mockResolvedValueOnce(response(detail())).mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve}))
 vi.stubGlobal('fetch',fetcher);const changed=vi.fn(),close=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomMembers api={api} view="b:room" onClose={close} onInvite={vi.fn()} onProfile={vi.fn()} onChanged={changed}/>)})
 const dialog=tree.root.findByType('member-dialog' as any);let pending!:Promise<void>
 act(()=>{pending=dialog.props.onRole(dialog.props.members[0],'admin')});act(()=>tree.unmount())
 await act(async()=>{complete(response({version:4}));await pending})
 expect(changed).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(2)
})

test('add candidates exclude joined people and a partial failure refreshes before retry',async()=>{
 const initial={...detail(),addableAgents:[{id:'agent',name:'Agent'}]}
 const afterPeople={...initial,members:{people:[...initial.members.people,{ref:'new-person',name:'New',roomRole:'member'}],agents:[]}}
 const final={...afterPeople,addableAgents:[],members:{...afterPeople.members,agents:[{id:'agent',name:'Agent',roomRole:'member'}]}}
 const fetcher=vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response({added:1})).mockResolvedValueOnce(response({message:'Agent changed.'},false)).mockResolvedValueOnce(response(afterPeople)).mockResolvedValueOnce(response({added:true})).mockResolvedValueOnce(response(final))
 vi.stubGlobal('fetch',fetcher);const changed=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomMembers api={api} view="b:room" people={[{ref:'person-ref',name:'Reader'},{ref:'new-person',name:'New'}]} onClose={vi.fn()} onInvite={vi.fn()} onProfile={vi.fn()} onChanged={changed}/>)})
 act(()=>tree.root.findByType('member-dialog' as any).props.onAdd())
 const picker=()=>tree.root.findByType(RoomMemberPicker)
 expect(picker().props.candidates.map((row:RoomCandidate)=>row.id)).toEqual(['new-person','agent'])
 await act(async()=>{await expect(picker().props.onAdd(picker().props.candidates)).rejects.toThrow('Agent changed.')})
 expect(picker().props.candidates.map((row:RoomCandidate)=>row.id)).toEqual(['agent'])
 expect(JSON.parse(fetcher.mock.calls[1][1].body).refs).toEqual(['new-person'])
 await act(async()=>picker().props.onAdd(picker().props.candidates))
 expect(fetcher.mock.calls.filter(call=>call[1]?.method==='POST').map(call=>call[0])).toEqual(['https://relay.test/channels/members','https://relay.test/channels/channel-agents','https://relay.test/channels/channel-agents'])
 expect(changed).toHaveBeenCalledTimes(2)
 expect(tree.root.findByType('member-dialog' as any)).toBeTruthy()
 act(()=>tree.unmount())
})

test('leaving the room during a multi-step addition prevents subsequent agent requests',async()=>{
 const initial={...detail(),addableAgents:[{id:'agent',name:'Agent'}]}
 let complete!:(value:any)=>void
 const fetcher=vi.fn().mockResolvedValueOnce(response(initial)).mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve}))
 vi.stubGlobal('fetch',fetcher);const changed=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomMembers api={api} view="b:room" people={[{ref:'new-person',name:'New'}]} onClose={vi.fn()} onInvite={vi.fn()} onProfile={vi.fn()} onChanged={changed}/>)})
 act(()=>tree.root.findByType('member-dialog' as any).props.onAdd())
 const picker=tree.root.findByType(RoomMemberPicker);let pending!:Promise<void>
 act(()=>{pending=picker.props.onAdd(picker.props.candidates)});act(()=>tree.unmount())
 await act(async()=>{complete(response({added:1}));await pending})
 expect(fetcher).toHaveBeenCalledTimes(2);expect(changed).not.toHaveBeenCalled()
})

test('direct Add entry waits for authoritative details and returns to the member list on Back',async()=>{
 let complete!:(value:any)=>void
 const fetcher=vi.fn(()=>new Promise(resolve=>{complete=resolve}));vi.stubGlobal('fetch',fetcher)
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<RoomMembers api={api} view="b:room" initialAdding onClose={vi.fn()} onInvite={vi.fn()} onProfile={vi.fn()} onChanged={vi.fn()}/>)})
 expect(tree.root.findByType('member-dialog' as any).props.loading).toBe(true)
 expect(tree.root.findAllByType(RoomMemberPicker)).toHaveLength(0)
 await act(async()=>complete(response({...detail(),addableAgents:[{id:'agent',name:'Assistant'}]})))
 const picker=tree.root.findByType(RoomMemberPicker)
 expect(picker.props.candidates).toHaveLength(1)
 act(()=>picker.props.onClose())
 expect(tree.root.findAllByType(RoomMemberPicker)).toHaveLength(0)
 expect(tree.root.findByType('member-dialog' as any).props.loading).toBe(false)
 act(()=>tree.unmount())
})

test('selected grant choice is sent to the server when adding an agent',async()=>{
 const initial={...detail(),addableAgents:[{id:'agent',name:'Agent',missingAccessMembers:[{id:'person',name:'Person'}],canGrantAccess:true}]}
 const final={...detail(),members:{...detail().members,agents:[{id:'agent',name:'Agent',roomRole:'member'}]}}
 const fetcher=vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response({added:true})).mockResolvedValueOnce(response(final))
 vi.stubGlobal('fetch',fetcher);const changed=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomMembers api={api} view="b:room" initialAdding onClose={vi.fn()} onInvite={vi.fn()} onProfile={vi.fn()} onChanged={changed}/>)})
 const picker=tree.root.findByType(RoomMemberPicker),selected={...picker.props.candidates[0],grantAccess:true}
 await act(async()=>picker.props.onAdd([selected]))
 expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({agentId:'agent',grantAccess:true})
 expect(changed).toHaveBeenCalledOnce()
 act(()=>tree.unmount())
})
