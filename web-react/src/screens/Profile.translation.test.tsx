import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { Profile } from './Profile'
import { displayVoiceShortcut } from '../utils/voiceShortcut'

vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text, changeLocale: vi.fn() }))
vi.mock('../utils/context', () => ({ getSenderContext: () => '', setSenderContext: vi.fn(), loadSenderContext: async () => '', saveSenderContext: async () => true, MAX_CONTEXT_CHARS: 1000 }))
vi.mock('../components/SignedInSessions', () => ({ SignedInSessions: () => null }))
vi.mock('../components/TidyChannels', () => ({ TidyChannels: () => null }))
vi.mock('../components/ArchivedChannels', () => ({ ArchivedChannels: () => null }))
vi.mock('../components/LanguageOptions', () => ({ LanguageOptions: () => null }))
vi.mock('../utils/appearance', () => ({ useAppearance: () => ({ theme: 'system', density: 'cozy' }), setAppearance: vi.fn(), THEMES: [], DENSITIES: [] }))
afterEach(() => vi.unstubAllGlobals())
const profile = { name: 'Synthetic reader', login: 'reader', email: null, locale: 'en', role: null, assignableRoles: [], translateMessages: true }

async function mount(save: () => Promise<unknown>) {
  vi.stubGlobal('window', new EventTarget())
  let voicePrefs = { vocabulary: [] as string[], corrections: [] as Array<{ from: string; to: string }>, voiceShortcut: 'Alt+Shift+V', revision: 0 }
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/hx/dictation-vocabulary')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body || '{}'))
        voicePrefs = { ...voicePrefs, voiceShortcut: body.voiceShortcut || voicePrefs.voiceShortcut, revision: voicePrefs.revision + 1 }
      }
      return Promise.resolve({ ok: true, json: async () => voicePrefs })
    }
    return init?.method === 'PUT' ? save() : Promise.resolve({ ok: true, json: async () => profile })
  }))
  const changed = vi.fn()
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<Profile httpBase="https://synthetic.invalid" orgId="org" userId="reader" sessionToken="synthetic" businesses={[]} pendingCount={0} decidedCount={0} onOpen={vi.fn()} onLocaleChange={vi.fn()} onTranslationChange={changed} onSwitchOrg={vi.fn()} onLogout={vi.fn()} onClose={vi.fn()} />) })
  return { tree, changed, button: () => tree.root.findByProps({ 'data-translate-messages': '1' }) }
}

test('publishes translation preference only after successful save; off and on use the existing screen', async () => {
  let finish!: (value: unknown) => void
  const save = vi.fn(() => new Promise(done => { finish = done }))
  const { tree, changed, button } = await mount(save)
  let pending!: Promise<void>
  act(() => { pending = button().props.onClick() })
  expect(button().props.disabled).toBe(true)
  expect(button().props['aria-checked']).toBe(true)
  expect(changed).not.toHaveBeenCalled()
  await act(async () => { finish({ ok: true }); await pending })
  expect(button().props['aria-checked']).toBe(false)
  expect(changed).toHaveBeenLastCalledWith(false)
  act(() => { pending = button().props.onClick() })
  await act(async () => { finish({ ok: true }); await pending })
  expect(button().props['aria-checked']).toBe(true)
  expect(changed).toHaveBeenLastCalledWith(true)
  act(() => tree.unmount())
})

test.each(['http', 'network'])('failed %s save stays visibly enabled and does not notify the chat', async failure => {
  const { tree, changed, button } = await mount(async () => { if (failure === 'network') throw new Error('synthetic offline'); return { ok: false } })
  await act(async () => { await button().props.onClick() })
  expect(button().props['aria-checked']).toBe(true)
  expect(changed).not.toHaveBeenCalled()
  expect(JSON.stringify(tree.toJSON())).toContain('That did not save.')
  act(() => tree.unmount())
})

test('voice input shortcut warns on a reserved chord and saves the next valid chord', async () => {
  const { tree } = await mount(async () => ({ ok: true }))
  const change = () => tree.root.findAllByType('button').find(button => button.children.includes('Change shortcut'))!
  act(() => change().props.onClick())
  const press = (key: string, modifiers: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => {
    const event = new Event('keydown') as KeyboardEvent
    for (const [name, value] of Object.entries({ key, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers })) Object.defineProperty(event, name, { value })
    window.dispatchEvent(event)
  }
  act(() => press('k', { ctrlKey: true }))
  expect(JSON.stringify(tree.toJSON())).toContain('That shortcut is already in use.')
  act(() => press('f', { metaKey: true }))
  expect(JSON.stringify(tree.toJSON())).toContain('That shortcut is already in use.')
  await act(async () => { press('m', { altKey: true, shiftKey: true }); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(tree.root.findByProps({ 'aria-label': 'Current voice input shortcut' }).children).toContain(displayVoiceShortcut('Alt+Shift+M'))
  expect(JSON.stringify(tree.toJSON())).toContain('Voice input shortcut saved.')
  const calls = vi.mocked(fetch).mock.calls
  const save = calls.find(([url, init]) => String(url).includes('/hx/dictation-vocabulary') && init?.method === 'PUT')
  expect(save).toBeTruthy()
  expect(JSON.parse(String(save?.[1]?.body))).toMatchObject({ orgId: 'org', voiceShortcut: 'Alt+Shift+M', expectedRevision: 0 })
  act(() => tree.unmount())
})

test('successful account deletion invokes forced teardown, not cancellable sign out', async () => {
  vi.stubGlobal('window',new EventTarget())
  vi.stubGlobal('fetch',vi.fn((_url:string,init?:RequestInit)=>Promise.resolve(init?.method==='DELETE'?{ok:true}:{ok:true,json:async()=>profile})))
  const signOut=vi.fn(),deleted=vi.fn()
  let tree!:ReturnType<typeof create>
  await act(async()=>{tree=create(<Profile httpBase="https://synthetic.invalid" orgId="org" userId="reader" sessionToken="synthetic" businesses={[]} pendingCount={0} decidedCount={0} onOpen={vi.fn()} onLocaleChange={vi.fn()} onTranslationChange={vi.fn()} onSwitchOrg={vi.fn()} onLogout={signOut} onAccountDeleted={deleted} onClose={vi.fn()} />)})
  const trigger=tree.root.findAllByType('button').find(button=>button.findAllByType('span').some(span=>span.children.includes('Delete account')))!
  act(()=>trigger.props.onClick())
  const confirm=tree.root.findAllByType('button').find(button=>button.children.includes('Delete'))!
  await act(async()=>{await confirm.props.onClick()})
  expect(deleted).toHaveBeenCalledOnce()
  expect(signOut).not.toHaveBeenCalled()
  act(()=>tree.unmount())
})
