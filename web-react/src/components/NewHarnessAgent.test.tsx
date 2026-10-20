import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AgentTierSelect } from './AgentTierSelect'
import { NewHarnessAgent } from './NewHarnessAgent'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
vi.mock('./Dialog', () => ({ Dialog: ({ children, footer, onClose }: any) => <section><button aria-label="Close dialog" onClick={onClose}/>{children}{footer}</section> }))
test('creates a private agent with one atomic profile request and prevents duplicate submission', async () => {
  let finish!: (value: unknown) => void
  const fetcher = vi.fn(() => new Promise(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetcher)
  const onCreated = vi.fn(), onClose = vi.fn()
  let tree!: ReturnType<typeof create>
  try {
    act(() => { tree = create(<NewHarnessAgent httpBase="https://example.test" orgId="one" sessionToken="session" onClose={onClose} onCreated={onCreated}/>) })
    const button = () => tree.root.findAllByType('button').find(b => b.children.includes('Create') || b.children.includes('Creating…'))!
    expect(button().props.disabled).toBe(true)
    act(() => {
      tree.root.findByProps({ placeholder: 'e.g. Atlas' }).props.onChange({ target: { value: '調査担当' } })
      tree.root.findByProps({ placeholder: 'e.g. Research and synthesis' }).props.onChange({ target: { value: '調査と統合' } })
      tree.root.findByType(AgentTierSelect).props.onChange('max')
    })
    await act(async () => { button().props.onClick(); button().props.onClick() })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetcher.mock.calls[0] as any)[1].body)
    expect(body).toMatchObject({ orgId: 'one', name: '調査担当', scope: 'personal', profile: { specialty: '調査と統合', tier: 'max' } })
    expect(body.handle).toMatch(/^agent-[a-f0-9]{8}$/)
    expect(body.instructions).toContain('調査担当')
    act(() => tree.root.findByProps({ 'aria-label': 'Close dialog' }).props.onClick())
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => finish({ ok: true, json: async () => ({ agent: { id: 'new' }, agents: [{ id: 'new' }] }) }))
    expect(onCreated).toHaveBeenCalledWith({ id: 'new' }, [{ id: 'new' }])
  } finally { act(() => tree?.unmount()); vi.unstubAllGlobals() }
})
test('a failed creation retains fields and the same handle for retry', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ message: 'Try again' }) })
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  try {
    act(() => { tree = create(<NewHarnessAgent httpBase="https://example.test" orgId="one" sessionToken="session" onClose={vi.fn()} onCreated={vi.fn()}/>) })
    act(() => tree.root.findByProps({ placeholder: 'e.g. Atlas' }).props.onChange({ target: { value: 'Atlas' } }))
    const submit = () => tree.root.findAllByType('button').find(b => b.children.includes('Create'))!.props.onClick()
    await act(async () => submit())
    expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Try again')
    expect(tree.root.findByProps({ placeholder: 'e.g. Atlas' }).props.value).toBe('Atlas')
    await act(async () => submit())
    expect(JSON.parse(fetcher.mock.calls[0][1].body).handle).toBe(JSON.parse(fetcher.mock.calls[1][1].body).handle)
  } finally { act(() => tree?.unmount()); vi.unstubAllGlobals() }
})
