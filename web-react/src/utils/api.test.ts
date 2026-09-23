import { describe, it, expect } from 'vitest'
import { apiBase, readResponse } from './api'

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
})
