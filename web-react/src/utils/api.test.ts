import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiBase, readResponse } from './api'
import { harnessApi } from './harness'

afterEach(()=>vi.restoreAllMocks())

const production = { protocol: 'https:', host: 'honmaru.example' }
describe('API origin configuration', () => {
  it('uses same origin in production and localhost only in development', () => {
    expect(apiBase(undefined, production)).toBe('https://honmaru.example')
    expect(apiBase(undefined, { protocol: 'http:', host: 'localhost:3000' }, true)).toBe('http://localhost:8787')
  })
  it('accepts a bare host or explicit secure API origin', () => {
    expect(apiBase('api.example', production)).toBe('https://api.example')
    expect(apiBase('https://api.example', production)).toBe('https://api.example')
  })
  it('refuses credential-bearing, insecure, and path-bearing production endpoints', () => {
    for (const endpoint of ['http://api.example', 'https://user:secret@api.example', 'https://api.example/path', 'javascript:alert(1)']) expect(() => apiBase(endpoint, production)).toThrow()
  })
  it('surfaces API failures and non-JSON responses instead of treating them as success', async () => {
    await expect(readResponse(new Response(JSON.stringify({ message: 'Session expired' }), { status: 401 }))).rejects.toThrow('Session expired')
    await expect(readResponse(new Response('<html>Not found</html>', { status: 404 }))).rejects.toThrow('unexpected response')
    await expect(readResponse(new Response(JSON.stringify({ token: 'ok' })))).resolves.toEqual({ token: 'ok' })
  })
  it('encodes a keyset run-history cursor and failure filter in the workflow page request', async()=>{
    const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({runs:[],hasMore:false,nextCursor:null}),{status:200}))
    const api=harnessApi('/api','workspace-1','session')
    await api.workflowRunsPage('wf/unsafe',{limit:25,cursor:'opaque+/=',status:'failed'})
    expect(fetch).toHaveBeenCalledWith('/api/workflows/wf/unsafe/runs?orgId=workspace-1&limit=25&cursor=opaque%2B%2F%3D&status=failed',expect.objectContaining({method:'GET'}))
    await api.workflowRunsPage('wf',{limit:50})
    expect(fetch.mock.calls[1][0]).toBe('/api/workflows/wf/runs?orgId=workspace-1&limit=50')
  })
  it('uses scoped table contract routes and pins publication to the observed schema version',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_input,init)=>new Response(JSON.stringify((init as RequestInit).method==='POST'?{contractVersion:'a'.repeat(64),created:true}:{}),{status:200}))
    const api=harnessApi('/api','workspace-1','session')
    await api.tableContract('table/one')
    await api.tableContracts('table/one')
    await api.tableContractVersion('table/one','a'.repeat(64))
    await api.publishTableContract('table/one','2026-11-21T00:00:00Z')
    expect(fetch.mock.calls.map(([url])=>url)).toEqual([
      '/api/tables/table%2Fone/contract?orgId=workspace-1',
      '/api/tables/table%2Fone/contracts?orgId=workspace-1',
      `/api/tables/table%2Fone/contracts/${'a'.repeat(64)}?orgId=workspace-1`,
      '/api/tables/table%2Fone/contracts',
    ])
    expect(JSON.parse(String(fetch.mock.calls[3][1]?.body))).toEqual({orgId:'workspace-1',expectedUpdatedAt:'2026-11-21T00:00:00Z'})
  })
})
