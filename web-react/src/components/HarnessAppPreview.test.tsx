import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { HarnessAppPreview } from './HarnessAppPreview'
import { CustomAppFrame } from './CustomApp'
vi.mock('./CustomApp', () => ({ CustomAppFrame: () => null }))
afterEach(() => vi.unstubAllGlobals())
test('published thumbnails receive real rows but no mutation or external API capability', async () => {
  const app = { id: 'app', version: 1, definition: { custom: { published: '<h1>Live</h1>' } } } as any
  const rows = [{ id: 'row', values: { name: 'Actual record' } }]
  const api = { app: vi.fn().mockResolvedValue({ app, rows, table: { name: 'Tasks', columns: [] } }) } as any
  vi.stubGlobal('IntersectionObserver', undefined)
  let tree: ReturnType<typeof create>
  await act(async () => { tree = create(<HarnessAppPreview app={app} api={api} httpBase="https://api.example" />, { createNodeMock: () => ({}) }) })
  const props = tree!.root.findByType(CustomAppFrame).props
  expect(props.rows).toBe(rows)
  expect(props.api).toBeUndefined()
  expect(props.appId).toBeUndefined()
  expect(props.decorative).toBe(true)
  act(() => tree!.unmount())
})
