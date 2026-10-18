import {afterEach,expect,test,vi} from 'vitest'
import {harnessApi} from './harness'
afterEach(()=>vi.unstubAllGlobals())
test('app conversation omits undefined record scope; record conversation encodes both IDs',async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({messages:[],hasMore:false})});vi.stubGlobal('fetch',fetch)
 const api=harnessApi('https://example.test','team:one','session')
 await api.conversation('app',{tableId:undefined,rowId:undefined})
 expect(fetch.mock.calls[0][0]).toBe('https://example.test/apps/app/conversation?orgId=team%3Aone')
 await api.conversation('app',{tableId:'table',rowId:'row'},42)
 const url=new URL(fetch.mock.calls[1][0]);expect(Object.fromEntries(url.searchParams)).toEqual({orgId:'team:one',tableId:'table',rowId:'row',before:'42'})
 await api.postConversation('app',{tableId:undefined,rowId:undefined},'Message','request_1234567890')
 expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({orgId:'team:one',body:'Message',requestId:'request_1234567890'})
})
