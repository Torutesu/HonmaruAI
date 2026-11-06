import {afterEach,expect,test,vi} from 'vitest'
import {harnessApi} from './harness'
afterEach(()=>vi.unstubAllGlobals())
test('peer Agent role API uses the exact managed Agent endpoint and access-version CAS body',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({version:4,scope:'team',managed:true,canManage:true,members:[],candidates:[{id:'peer',name:'Peer'}]})}).mockResolvedValueOnce({ok:true,json:async()=>({version:5})})
 vi.stubGlobal('fetch',fetch)
 const api=harnessApi('https://example.test','team:one','session')
 const state=await api.agentPeerMembers('agent/id')
 expect(new URL(fetch.mock.calls[0][0]).pathname).toBe('/hx/agents/agent%2Fid/agent-members')
 expect(new URL(fetch.mock.calls[0][0]).searchParams.get('orgId')).toBe('team:one')
 expect(state.candidates).toEqual([{id:'peer',name:'Peer'}])
 await api.setAgentPeerMember('agent/id','peer/id','admin',4)
 expect(fetch.mock.calls[1][0]).toBe('https://example.test/hx/agents/agent%2Fid/agent-members')
 expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({orgId:'team:one',memberAgentId:'peer/id',role:'admin',expectedVersion:4})
 expect(fetch.mock.calls[1][1].headers['x-session-token']).toBe('session')
})
test('peer role API surfaces a CAS conflict without retrying',async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:false,status:409,json:async()=>({message:'Agent access changed. Reload before saving.'})});vi.stubGlobal('fetch',fetch)
 const api=harnessApi('https://example.test','team:one','session')
 await expect(api.setAgentPeerMember('owner','peer','member',2)).rejects.toMatchObject({status:409})
 expect(fetch).toHaveBeenCalledTimes(1)
})
