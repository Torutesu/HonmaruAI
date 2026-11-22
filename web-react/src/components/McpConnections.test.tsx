import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { McpConnections } from './McpConnections'

vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))

afterEach(() => vi.unstubAllGlobals())

test('shows the ChatGPT setup steps and copies the workspace MCP endpoint', async () => {
  const endpoint = 'https://api.example/mcp'
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const payload = url.endsWith('/clients') ? { clients: [], resource: endpoint }
      : url.endsWith('/connections') ? { connections: [] }
        : { scopes: [] }
    return { ok: true, json: async () => payload }
  }))
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })

  let tree!: ReactTestRenderer
  await act(async () => { tree = create(<McpConnections httpBase="https://api.example" orgId="org-1" sessionToken="session" />) })
  const markup = JSON.stringify(tree.toJSON())
  expect(markup).toContain('Connect ChatGPT to Honmaru')
  expect(markup).toContain('mcp.chatgpt.step3')
  expect(markup).toContain(endpoint)
  expect(markup).toContain('https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt')

  const copy = tree.root.findAllByType('button').find(button => button.children.includes('Copy MCP URL'))!
  await act(async () => { copy.props.onClick() })
  expect(writeText).toHaveBeenCalledWith(endpoint)
  expect(JSON.stringify(tree.toJSON())).toContain('MCP URL copied.')
  act(() => tree.unmount())
})
