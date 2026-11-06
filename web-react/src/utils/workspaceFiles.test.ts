import {afterEach,expect,test,vi} from 'vitest'
import {workspaceFileApi,WorkspaceFileError} from './workspaceFiles'
afterEach(()=>vi.unstubAllGlobals())
test('file requests keep credentials in headers and encode explicit scopes and cursors',async()=>{
 const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({files:[],next:null})));vi.stubGlobal('fetch',fetcher)
 const api=workspaceFileApi('https://api.example/','org one','private-token'),controller=new AbortController()
 await api.list({scope:'b:design',query:'50% report',cursor:{path:'a b.txt',id:'id/one'}},controller.signal)
 const [address,request]=fetcher.mock.calls[0],url=new URL(address)
 expect(url.searchParams.get('orgId')).toBe('org one');expect(url.searchParams.get('scope')).toBe('b:design');expect(url.searchParams.get('query')).toBe('50% report')
 expect(address).not.toContain('private-token');expect(request.headers['x-session-token']).toBe('private-token');expect(request.signal).toBe(controller.signal)
 expect(JSON.parse(url.searchParams.get('cursor')!)).toEqual({path:'a b.txt',id:'id/one'})
})
test('uploads send binary bytes and DELETE retains the expected-version body',async()=>{
 const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response('{"saved":true,"version":3}')));vi.stubGlobal('fetch',fetcher)
 const api=workspaceFileApi('https://api.example','org','token'),file=new Blob(['hello'],{type:'text/plain'})
 await api.upload('a/b',2,file)
 expect(fetcher.mock.calls[0][0]).toContain('/hx/files/a%2Fb/content?');expect(fetcher.mock.calls[0][1].body).toBe(file)
 expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('size')).toBe('5')
 await api.remove('a/b',3);expect(fetcher.mock.calls[1][1].method).toBe('DELETE');expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({expectedVersion:3})
})
test('conflicts preserve HTTP status for a refresh decision without retrying mutations',async()=>{
 const fetcher=vi.fn().mockResolvedValue(new Response('{"message":"Refresh the file"}',{status:409}));vi.stubGlobal('fetch',fetcher)
 const api=workspaceFileApi('https://api.example','org','token')
 await expect(api.restore('file',1,2)).rejects.toMatchObject({name:'WorkspaceFileError',status:409,message:'Refresh the file'})
 expect(fetcher).toHaveBeenCalledTimes(1);expect(new WorkspaceFileError('failure',503).status).toBe(503)
})

test('direct metadata lookup uses encoded identifiers and keeps session credentials out of the link',async()=>{
 const fetcher=vi.fn().mockResolvedValue(new Response('{"file":{"id":"file/one","version":2}}'));vi.stubGlobal('fetch',fetcher)
 const controller=new AbortController(),api=workspaceFileApi('https://api.example/','org one','private-token')
 expect(await api.get('file/one',controller.signal)).toEqual({file:{id:'file/one',version:2}})
 const [address,request]=fetcher.mock.calls[0]
 expect(address).toBe('https://api.example/hx/files/file%2Fone?orgId=org+one')
 expect(request.headers['x-session-token']).toBe('private-token');expect(request.signal).toBe(controller.signal)
})


test('public file sharing API requests expose metadata without tokens and send approval and revocation commands',async()=>{
 const fetcher=vi.fn()
  .mockResolvedValueOnce(new Response(JSON.stringify({requestId:'req',status:'pending',fileId:'file/one',version:2,contentHash:'a'.repeat(64),expiresAt:'2026-11-07T00:00:00.000Z',allowDownload:false})))
  .mockResolvedValueOnce(new Response(JSON.stringify({requests:[{id:'req',fileId:'file/one',filePath:'reports/a.txt',scope:'workspace',version:2,contentHash:'a'.repeat(64),contentType:'text/plain',size:3,expiresAt:'2026-11-07T00:00:00.000Z',allowDownload:false,status:'pending',createdAt:'2026-11-06T00:00:00.000Z',requesterLogin:'agent',decisionAt:null,shareId:null,revokedAt:null,revokedBy:null}]})))
  .mockResolvedValueOnce(new Response(JSON.stringify({shareId:'share',url:'/hx/public-file-shares/opaque',expiresAt:'2026-11-07T00:00:00.000Z',allowDownload:false})))
  .mockResolvedValueOnce(new Response(JSON.stringify({shareId:'share',revokedAt:'2026-11-06T01:00:00.000Z'})))
 vi.stubGlobal('fetch',fetcher)
 const api=workspaceFileApi('https://api.example','org','session')
 const requested=await api.requestPublicShare('file/one',2,86400,false)
 expect(requested.requestId).toBe('req')
 expect(fetcher.mock.calls[0][0]).toContain('/hx/files/file%2Fone/share-requests?')
 expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({version:2,expiresIn:86400,allowDownload:false})
 const queue=await api.shareRequests()
 expect(queue.requests[0]).toMatchObject({filePath:'reports/a.txt',contentType:'text/plain',size:3})
 expect(JSON.stringify(queue)).not.toContain('opaque')
 const approved=await api.approvePublicShare('req')
 expect(approved.url).toBe('https://api.example/hx/public-file-shares/opaque')
 expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({requestId:'req'})
 await api.revokePublicShare('share')
 expect(fetcher.mock.calls[3][0]).toContain('/hx/files/shares/share/revoke?')
 expect(fetcher.mock.calls[3][1].method).toBe('POST')
})
