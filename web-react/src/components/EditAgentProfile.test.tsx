import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { EditAgentProfile } from './EditAgentProfile'
vi.mock('./Dialog', () => ({ Dialog: ({ children, footer }: any) => <div>{children}{footer}</div> }))
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
test('profile dialog keeps drafts on failure and saves the whole profile on explicit submit', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue(undefined)
  const close = vi.fn()
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(<EditAgentProfile agent={{ id: 'one', name: 'Atlas', emoji: '🤖' }} profile={{ specialty: '', tier: 'standard', mentionOnly: false, access: 'private', people: [] }} onSave={save} onClose={close}/>) })
  const submit = () => tree.root.findAllByType('button').find(x => x.children.includes('Save'))!
  expect(submit().props.disabled).toBe(true)
  act(() => tree.root.findAllByType('input')[0].props.onChange({ target: { value: 'Researcher' } }))
  act(() => tree.root.findAllByType('input')[1].props.onChange({ target: { value: 'Research' } }))
  expect(save).not.toHaveBeenCalled()
  await act(async () => submit().props.onClick())
  expect(close).not.toHaveBeenCalled()
  expect(tree.root.findAllByType('input')[0].props.value).toBe('Researcher')
  expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Unavailable')
  await act(async () => submit().props.onClick())
  expect(save).toHaveBeenLastCalledWith({ name: 'Researcher', emoji: '🤖', specialty: 'Research', tier: 'standard' })
  expect(close).toHaveBeenCalledOnce()
  act(() => tree.unmount())
})
