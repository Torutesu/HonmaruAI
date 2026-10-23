import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {RoomVisual} from './RoomVisual'
const api={httpBase:'https://relay.test',orgId:'org',sessionToken:'token'}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})
test('revokes private image URLs and hides the old image immediately on scope change',async()=>{
 const make=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:private'),revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{})
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(new Blob(['image'],{type:'image/png'}))).mockImplementationOnce(()=>new Promise(()=>{})))
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomVisual api={api} channel="b:first" version={1} fallback={<span>Icon</span>}/>)})
 expect(tree.root.findByType('img').props.src).toBe('blob:private')
 act(()=>tree.update(<RoomVisual api={{...api,orgId:'other'}} channel="b:first" version={1} fallback={<span>Icon</span>}/>))
 expect(tree.root.findAllByType('img')).toHaveLength(0);expect(revoke).toHaveBeenCalledWith('blob:private')
 expect(make).toHaveBeenCalledOnce();act(()=>tree.unmount())
})
test('late image bodies from a closed room never create a displayable URL',async()=>{
 let finish!:(value:Blob)=>void
 const make=vi.spyOn(URL,'createObjectURL')
 const fetcher=vi.fn().mockResolvedValue({ok:true,blob:()=>new Promise(resolve=>{finish=resolve})});vi.stubGlobal('fetch',fetcher)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomVisual api={api} channel="b:first" version={1} fallback={<span>Icon</span>}/>)})
 act(()=>tree.unmount())
 await act(async()=>finish(new Blob(['private'],{type:'image/png'})))
 expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);expect(make).not.toHaveBeenCalled()
})
