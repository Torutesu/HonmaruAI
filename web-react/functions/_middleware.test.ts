import { afterEach, expect, test, vi } from 'vitest'
import { onRequest } from './_middleware.js'

afterEach(() => vi.unstubAllGlobals())

test('custom app root resolves through the Worker using its request hostname', async () => {
  const fetchStub = vi.fn(async () => new Response('<!doctype html><title>Published app</title>', { headers: { 'content-type': 'text/html' } }))
  vi.stubGlobal('fetch', fetchStub)
  const response = await onRequest({
    request: new Request('https://tools.example.com/'),
    env: { API_HOST: 'api.example.com' },
    next: vi.fn(),
  } as never)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(String(fetchStub.mock.calls[0][0])).toBe('https://api.example.com/app-domains/resolve?host=tools.example.com')
})

test('custom app iframe runner is proxied to the same Worker', async () => {
  const fetchStub = vi.fn(async () => new Response('window.addEventListener("message", () => {})', { headers: { 'content-type': 'application/javascript' } }))
  vi.stubGlobal('fetch', fetchStub)
  const response = await onRequest({
    request: new Request('https://tools.example.com/custom-app-runner?v=4', { headers: { accept: 'application/javascript' } }),
    env: { API_HOST: 'api.example.com' },
    next: vi.fn(),
  } as never)
  expect(response.status).toBe(200)
  expect(String(fetchStub.mock.calls[0][0])).toBe('https://api.example.com/custom-app-runner?v=4')
})

test('Honmaru and Pages hosts continue to their existing Pages routes', async () => {
  const fetchStub = vi.fn()
  vi.stubGlobal('fetch', fetchStub)
  const next = vi.fn(async () => new Response('next'))
  const response = await onRequest({
    request: new Request('https://app.honmaruai.com/custom-app-runner?v=4'),
    env: { API_HOST: 'api.example.com' },
    next,
  } as never)
  expect(await response.text()).toBe('next')
  expect(next).toHaveBeenCalledOnce()
  expect(fetchStub).not.toHaveBeenCalled()
})
