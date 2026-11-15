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
})
