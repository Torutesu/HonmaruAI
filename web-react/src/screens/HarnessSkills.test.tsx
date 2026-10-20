import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { HarnessSkills } from './HarnessAgents'
const state = vi.hoisted(() => ({ api: null as any }))
vi.mock('./HarnessShared', async importOriginal => ({ ...(await importOriginal<any>()), useApi: () => state.api }))
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
const props = { httpBase: 'https://example.test', orgId: 'one', sessionToken: 'test', onClose: () => {} }
const draft = { name: 'Review', description: 'Review changes', body: 'Check permissions.', metadata: { license: 'MIT' } }
function api() { return { skills: vi.fn().mockResolvedValue({ skills: [] }), previewSkillImport: vi.fn().mockResolvedValue({ draft }), createSkill: vi.fn().mockResolvedValue({}) } }
test('import is reviewed before private save and preserves metadata', async () => {
  state.api = api(); let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<HarnessSkills {...props} />) })
  await act(async () => { tree.root.findByProps({ type: 'file', accept: '.md,.zip,text/markdown,application/zip' }).props.onChange({ target: { files: [{ name: 'SKILL.md', size: 100, text: async () => 'markdown' }], value: 'file' } }) })
  expect(state.api.createSkill).not.toHaveBeenCalled()
  expect(tree.root.findByProps({ 'aria-label': 'Skill name' }).props.value).toBe('Review')
  await act(async () => { tree.root.findAllByType('button').find(b => b.children.includes('Save'))!.props.onClick() })
  expect(state.api.createSkill).toHaveBeenCalledWith({ ...draft, visibility: 'private' })
  act(() => tree.unmount())
})
test('late preview from the previous workspace never opens a draft', async () => {
  state.api = api(); let resolve!: (value: any) => void
  state.api.previewSkillImport.mockReturnValue(new Promise(r => { resolve = r }))
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<HarnessSkills {...props} />) })
  await act(async () => { tree.root.findByProps({ type: 'file', accept: '.md,.zip,text/markdown,application/zip' }).props.onChange({ target: { files: [{ name: 'SKILL.md', size: 100, text: async () => 'markdown' }], value: 'file' } }) })
  state.api = api()
  await act(async () => { tree.update(<HarnessSkills {...props} orgId="two" />) })
  await act(async () => { resolve({ draft }) })
  expect(tree.root.findAllByProps({ 'aria-label': 'Skill name' })).toHaveLength(0)
  expect(state.api.createSkill).not.toHaveBeenCalled()
  act(() => tree.unmount())
})
test('late list failures from an old session cannot replace the current skills or error state', async () => {
  state.api = api()
  let reject!: (reason: Error) => void
  state.api.skills.mockReturnValue(new Promise((_, fail) => { reject = fail }))
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<HarnessSkills {...props} />) })
  state.api = api()
  state.api.skills.mockResolvedValue({ skills: [{ id: 'new', name: 'Current skill', description: 'Current session', body: '', visibility: 'private' }] })
  await act(async () => { tree.update(<HarnessSkills {...props} sessionToken="new-session" />) })
  await act(async () => { reject(new Error('Previous session error')) })
  expect(JSON.stringify(tree.toJSON())).toContain('Current skill')
  expect(JSON.stringify(tree.toJSON())).not.toContain('Previous session error')
  act(() => tree.unmount())
})
