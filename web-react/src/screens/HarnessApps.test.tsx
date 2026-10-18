import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HarnessApps } from './Harness'

const state = vi.hoisted(() => ({ api: null as any }))
vi.mock('./HarnessShared', async importOriginal => ({
  ...await importOriginal<typeof import('./HarnessShared')>(),
  useApi: () => state.api,
}))
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
vi.mock('../utils/appPins', () => ({ useAppPins: () => ({ pins: [], toggle: vi.fn() }) }))
let finish: (value: any) => void
let tree: ReturnType<typeof create> | undefined
beforeEach(() => {
  vi.stubGlobal('location', { hash: '#/apps' })
  state.api = {
    apps: vi.fn().mockResolvedValue({ apps: [] }),
    templates: vi.fn().mockResolvedValue({ templates: [] }),
    generate: vi.fn(() => new Promise(resolve => { finish = resolve })),
    app: vi.fn(() => new Promise(() => {})),
    personalViews: vi.fn(() => new Promise(() => {})),
  }
})
afterEach(() => { if (tree) act(() => tree!.unmount()); tree = undefined; vi.unstubAllGlobals() })
const button = (label: string) => tree!.root.findAllByType('button').find(node => node.props.children === label)!
async function start() {
  await act(async () => { tree = create(<HarnessApps httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={() => {}} />) })
  act(() => button('Build an app').props.onClick())
  act(() => tree!.root.findByType('textarea').props.onChange({ target: { value: 'First request' } }))
  let completion!: Promise<void>
  act(() => { completion = button('Build').props.onClick() })
  return { completion }
}
test('generation still opens its app when the same screen is active', async () => {
  const { completion } = await start()
  await act(async () => { finish({ app: { id: 'created' }, source: 'template' }); await completion })
  expect(location.hash).toBe('#/apps/created/team%3Aone')
})
test('late completion retains another destination and a revised prompt', async () => {
  const { completion } = await start()
  act(() => tree!.root.findByType('textarea').props.onChange({ target: { value: 'Next request' } }))
  location.hash = '#/apps/another/team%3Aone'
  await act(async () => { finish({ app: { id: 'created' }, source: 'template' }); await completion })
  expect(location.hash).toBe('#/apps/another/team%3Aone')
  expect(tree!.root.findByType('textarea').props.value).toBe('Next request')
})
test('completion from an unmounted account cannot navigate the new account', async () => {
  const { completion } = await start()
  act(() => tree!.unmount()); tree = undefined
  location.hash = '#/apps/other/team%3Atwo'
  await act(async () => { finish({ app: { id: 'created' }, source: 'template' }); await completion })
  expect(location.hash).toBe('#/apps/other/team%3Atwo')
})
