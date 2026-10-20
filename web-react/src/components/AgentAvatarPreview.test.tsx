import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AgentAvatarPreview } from './AgentAvatarPreview'
vi.mock('./Dialog', () => ({ Dialog: ({ children }: any) => <div>{children}</div> }))
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
test('avatar viewer clamps zoom and drag, resets position and falls back on image failure', () => {
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(<AgentAvatarPreview agent={{ name: 'Atlas', avatarUrl: 'https://example.test/avatar.png', emoji: '🔎' }} onClose={() => {}}/>, { createNodeMock: () => ({ getBoundingClientRect: () => ({ width: 500, height: 500 }) }) }) })
  const zoomIn = () => tree.root.findByProps({ 'aria-label': 'Zoom in' })
  const reset = () => tree.root.findByProps({ 'aria-label': 'Reset zoom' })
  for (let i = 0; i < 15; i++) act(() => zoomIn().props.onClick())
  expect(zoomIn().props.disabled).toBe(true)
  expect(reset().children.join('')).toBe('400%')
  const region = tree.root.findByProps({ role: 'region' })
  act(() => region.props.onPointerDown({ button: 0, pointerId: 1, clientX: 0, clientY: 0, currentTarget: { setPointerCapture: vi.fn() } }))
  act(() => region.props.onPointerMove({ pointerId: 1, clientX: 9999, clientY: -9999 }))
  expect(tree.root.findByProps({ className: 'hx-avatar-preview-image' }).props.style.transform).toContain('translate(750px, -750px)')
  act(() => reset().props.onClick())
  expect(tree.root.findByProps({ className: 'hx-avatar-preview-image' }).props.style.transform).toBe('translate(0px, 0px) scale(1)')
  act(() => tree.root.findByType('img').props.onError())
  expect(tree.root.findAllByType('img')).toHaveLength(0)
  expect(tree.root.findByProps({ role: 'status' }).children).toContain('The picture could not be loaded.')
  act(() => tree.unmount())
})
