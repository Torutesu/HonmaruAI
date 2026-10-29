import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MessageFiles } from './Attachments'

vi.mock('react-dom', async importOriginal => ({ ...await importOriginal<typeof import('react-dom')>(), createPortal: (child: React.ReactNode) => child }))
afterEach(() => vi.unstubAllGlobals())

it.each(['https://media.example/files/image?e=1&s=abc', '/files/image?e=1&s=abc'])('downloads image %s explicitly while displaying its inline URL', url => {
  vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const file = { id: 'image', name: 'original.png', type: 'image/png', size: 2048, url }
  let view: ReturnType<typeof create>
  act(() => { view = create(<MessageFiles files={[file]} base="https://api.example" />) })
  act(() => view!.root.findByProps({ className: 'att-pic' }).props.onClick())
  const download = view!.root.findByProps({ 'aria-label': 'Download' })
  const image = view!.root.findByProps({ className: 'att-light' }).findByType('img')
  expect(download.props.href).toBe(`${image.props.src}&download=1`)
  expect(download.props.href).toContain('e=1&s=abc&download=1')
  expect(image.props.src).not.toContain('download=1')
  expect(view!.root.findByProps({ className: 'att-light-name' }).children).toContain('original.png')
  act(() => view!.root.findByProps({ 'aria-label': 'Close' }).props.onClick())
  expect(view!.root.findAllByProps({ className: 'att-light' })).toHaveLength(0)
  act(() => view!.unmount())
})
