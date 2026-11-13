import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { JoinInviteDialog } from './JoinInviteDialog'

vi.mock('./Dialog', () => ({ Dialog: ({ title, children, footer }: any) => <section aria-label={title}>{children}{footer}</section> }))
vi.mock('../utils/i18n', () => ({ useT: () => ((text: string, vars?: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => vars?.[key] ?? `{${key}}`)) }))
afterEach(() => vi.unstubAllGlobals())

const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const text = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON())
const button = (tree: ReactTestRenderer, label: string) => tree.root.findAllByType('button').find((b) => b.children.join('') === label)!
const accepts = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([url]) => String(url).endsWith('/invites/accept'))

async function open(acceptReply?: unknown) {
  const fetch = vi.fn(async (url: string) => String(url).includes('/invites/peek')
    ? reply({ team: 'Acme', inviter: 'Mallory', role: 'member' })
    : acceptReply)
  vi.stubGlobal('fetch', fetch)
  const onClose = vi.fn(), onOpen = vi.fn()
  let tree!: ReactTestRenderer
  await act(async () => { tree = create(<JoinInviteDialog httpBase="https://api.test" sessionToken="session" code="abc123" onClose={onClose} onOpen={onOpen} />); await flush() })
  return { fetch, tree, onClose, onOpen }
}

test('names the workspace from the preview and redeems nothing until Join is pressed; Cancel joins nothing', async () => {
  const { fetch, tree, onClose, onOpen } = await open()
  expect(fetch.mock.calls[0][0]).toBe('https://api.test/invites/peek?code=abc123')
  expect(text(tree)).toContain('Join Acme?')
  expect(text(tree)).toContain('Mallory invited you to this workspace.')
  expect(accepts(fetch)).toHaveLength(0)
  act(() => button(tree, 'Cancel').props.onClick())
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(onOpen).not.toHaveBeenCalled()
  expect(accepts(fetch)).toHaveLength(0)
  act(() => tree.unmount())
})

test('after joining, the person chooses whether to open the workspace', async () => {
  const { fetch, tree, onClose, onOpen } = await open(reply({ orgId: 'org-acme', joined: true, role: 'member' }))
  await act(async () => { button(tree, 'Join').props.onClick(); await flush() })
  expect(accepts(fetch)).toHaveLength(1)
  expect(accepts(fetch)[0][1]).toMatchObject({ method: 'POST', headers: { 'x-session-token': 'session' }, body: JSON.stringify({ code: 'abc123' }) })
  expect(text(tree)).toContain('You joined Acme.')
  expect(onOpen).not.toHaveBeenCalled()
  act(() => button(tree, 'Stay here').props.onClick())
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(onOpen).not.toHaveBeenCalled()
  act(() => button(tree, 'Open Acme').props.onClick())
  expect(onOpen).toHaveBeenCalledWith('org-acme')
  act(() => tree.unmount())
})

test('a held (202) answer is approval pending: no switch and no "joined"', async () => {
  const { tree, onOpen } = await open(reply({ orgId: 'org-acme', pending: true, role: 'member', message: 'An admin of this workspace needs to approve you.' }, 202))
  await act(async () => { button(tree, 'Join').props.onClick(); await flush() })
  expect(text(tree)).toContain('An admin of Acme needs to approve you. You will be let in once they do.')
  expect(text(tree)).not.toContain('You joined')
  expect(tree.root.findAllByType('button').map((b) => b.children.join(''))).toEqual(['Close'])
  expect(onOpen).not.toHaveBeenCalled()
  act(() => tree.unmount())
})

test('a refused join keeps the question open with the reason', async () => {
  const { tree, onOpen } = await open(reply({ message: 'This workspace only admits company accounts.' }, 403))
  await act(async () => { button(tree, 'Join').props.onClick(); await flush() })
  expect(tree.root.findByProps({ role: 'alert' }).children).toContain('This workspace only admits company accounts.')
  expect(onOpen).not.toHaveBeenCalled()
  act(() => tree.unmount())
})

test('an unknown or spent code says so and offers nothing to join', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ message: 'That invite code is not valid.' }, 404)))
  let tree!: ReactTestRenderer
  await act(async () => { tree = create(<JoinInviteDialog httpBase="https://api.test" sessionToken="session" code="nope" onClose={vi.fn()} onOpen={vi.fn()} />); await flush() })
  expect(text(tree)).toContain('This invitation is not valid, or has expired.')
  expect(tree.root.findAllByType('button').map((b) => b.children.join(''))).toEqual(['Close'])
  act(() => tree.unmount())
})
