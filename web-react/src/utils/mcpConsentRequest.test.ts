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
