import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,test,expect,vi} from 'vitest'
import {RoomMembers} from './RoomMembers'
vi.mock('./RoomMembersDialog',()=>({RoomMembersDialog:(props:any)=>React.createElement('member-dialog',props)}))
const api={httpBase:'https://relay.test',orgId:'one',sessionToken:'session'}
const detail=(version=3)=>({channel:{managed:true,version,canInvite:true},members:{people:[{ref:'person-ref',name:'Reader',roomRole:'member',canChangeRole:true}],agents:[]}})
const response=(data:any,ok=true)=>({ok,json:async()=>data})
afterEach(()=>vi.unstubAllGlobals())
test('role changes use the reviewed version and refresh the members after success',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(detail())).mockResolvedValueOnce(response({version:4})).mockResolvedValueOnce(response(detail(4)))
 vi.stubGlobal('fetch',fetcher);const changed=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomMembers api={api} view="b:room" onClose={vi.fn()} onAdd={vi.fn()} onProfile={vi.fn()} onChanged={changed}/>)})
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
 await act(async()=>{tree=create(<RoomMembers api={api} view="b:room" onClose={vi.fn()} onAdd={vi.fn()} onProfile={vi.fn()} onChanged={changed}/>)})
 const dialog=tree.root.findByType('member-dialog' as any)
 await act(async()=>{await expect(dialog.props.onRole(dialog.props.members[0],'admin')).rejects.toThrow('Room roles changed.')})
 expect(changed).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(3)
 act(()=>tree.unmount())
})
test('a mutation finishing after unmount cannot update or navigate another room',async()=>{
 let complete!:(value:any)=>void
 const fetcher=vi.fn().mockResolvedValueOnce(response(detail())).mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve}))
 vi.stubGlobal('fetch',fetcher);const changed=vi.fn(),close=vi.fn();let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomMembers api={api} view="b:room" onClose={close} onAdd={vi.fn()} onProfile={vi.fn()} onChanged={changed}/>)})
 const dialog=tree.root.findByType('member-dialog' as any);let pending!:Promise<void>
 act(()=>{pending=dialog.props.onRole(dialog.props.members[0],'admin')});act(()=>tree.unmount())
 await act(async()=>{complete(response({version:4}));await pending})
 expect(changed).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(2)
})
