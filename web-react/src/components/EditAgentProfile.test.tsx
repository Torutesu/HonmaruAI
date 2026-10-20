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
  act(() => tree.root.findByProps({ maxLength: 40 }).props.onChange({ target: { value: 'Researcher' } }))
  act(() => tree.root.findByProps({ maxLength: 120 }).props.onChange({ target: { value: 'Research' } }))
  expect(save).not.toHaveBeenCalled()
  await act(async () => submit().props.onClick())
  expect(close).not.toHaveBeenCalled()
  expect(tree.root.findByProps({ maxLength: 40 }).props.value).toBe('Researcher')
  expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Unavailable')
  await act(async () => submit().props.onClick())
  expect(save).toHaveBeenLastCalledWith({ name: 'Researcher', emoji: '🤖', specialty: 'Research', tier: 'standard' }, undefined)
  expect(close).toHaveBeenCalledOnce()
  act(() => tree.unmount())
})
test('picture selection stays local until Save, validates file type and releases preview URLs', async () => {
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const save = vi.fn().mockResolvedValue(undefined)
  let tree!: ReturnType<typeof create>
  try {
    act(() => { tree = create(<EditAgentProfile agent={{ id: 'one', name: 'Atlas', avatarUrl: 'https://example.test/old.png' }} profile={{ specialty: '', tier: 'standard', mentionOnly: false, access: 'private', people: [] }} onSave={save} onClose={() => {}}/>) })
    const choose = (file: File) => tree.root.findByProps({ type: 'file' }).props.onChange({ target: { files: [file], value: 'chosen' } })
    act(() => choose(new File(['<svg/>'], 'unsafe.svg', { type: 'image/svg+xml' })))
    expect(createUrl).not.toHaveBeenCalled()
    expect(tree.root.findByProps({ role: 'alert' }).children).toContain('A picture is a PNG, JPEG, WebP or GIF.')
    const file = new File(['test image'], 'avatar.png', { type: 'image/png' })
    act(() => choose(file))
    expect(tree.root.findByType('img').props.src).toBe('blob:preview')
    expect(save).not.toHaveBeenCalled()
    await act(async () => tree.root.findAllByType('button').find(x => x.children.includes('Save'))!.props.onClick())
    expect(save.mock.calls[0][1]).toBe(file)
    act(() => tree.unmount())
    expect(revoke).toHaveBeenCalledWith('blob:preview')
  } finally { createUrl.mockRestore(); revoke.mockRestore() }
})
