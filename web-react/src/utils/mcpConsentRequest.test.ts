import { expect, test } from 'vitest'
import { clearMcpRequest, pendingMcpRequest } from './mcpConsentRequest'
function storage() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) || null, setItem: (key: string, value: string) => { items.set(key, value) }, removeItem: (key: string) => { items.delete(key) } }
}
test('a consent request survives login redirects and clears after a decision', () => {
  const store = storage(), id = `hmreq_${'a'.repeat(64)}`
  expect(pendingMcpRequest(`#/mcp/consent/${id}`, store)).toBe(id)
  expect(pendingMcpRequest('#/sso/done?code=one-time', store)).toBe(id)
  clearMcpRequest(store)
  expect(pendingMcpRequest('#/list', store)).toBe('')
})
test('malformed IDs do not become pending authorization requests', () => {
  const store = storage()
  expect(pendingMcpRequest('#/mcp/consent/https://attacker.example', store)).toBe('')
  store.setItem('honmaru:mcp-consent', '<script>')
  expect(pendingMcpRequest('#/list', store)).toBe('')
})

test.each(['missing', 'blocked'])('consent works when browser session storage is %s', mode => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  try {
    if (mode === 'missing') Reflect.deleteProperty(globalThis, 'sessionStorage')
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new DOMException('Storage blocked', 'SecurityError') } })
    const id = `hmreq_${'b'.repeat(64)}`
    expect(pendingMcpRequest(`#/mcp/consent/${id}`)).toBe(id)
    expect(pendingMcpRequest('#/list')).toBe('')
    expect(() => clearMcpRequest()).not.toThrow()
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original)
    else Reflect.deleteProperty(globalThis, 'sessionStorage')
  }
})
