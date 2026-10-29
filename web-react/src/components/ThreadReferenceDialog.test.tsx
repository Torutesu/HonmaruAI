import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ChannelMessage, FileRef } from '../types/card'
import { ThreadReferenceDialog } from './ThreadReferenceDialog'
vi.mock('./Dialog', () => ({ Dialog: ({ children }: { children: React.ReactNode }) => <section>{children}</section> }))
const file = (id: string, name: string, type: string): FileRef => ({ id, name, type, size: 2048, url: `/files/${id}?token=signed` })
const message = { id: 'old', body: '', files: [file('picture', 'Photo.png', 'image/png'), file('audio', 'Memo.mp3', 'audio/mpeg'), file('archive', 'Notes.zip', 'application/zip')] } as ChannelMessage
const html = (state: { message?: ChannelMessage; failed?: boolean }) => renderToStaticMarkup(<ThreadReferenceDialog {...state} base="https://api.example" name="Reader" at="Yesterday" onClose={() => {}} />)
it('renders authorized files even when the unloaded original has no text', () => {
  const out = html({ message })
  expect(out).toContain('https://api.example/files/picture?token=signed')
  expect(out).toContain('alt="Photo.png"')
  expect(out).toContain('<audio')
  expect(out).toContain('aria-label="Memo.mp3"')
  expect(out).toContain('https://api.example/files/archive?token=signed')
  expect(out).toContain('Notes.zip')
})
it('never renders stale text or signed files when the original is unavailable or deleted', () => {
  for (const state of [{ message, failed: true }, { message: { ...message, deleted: true } }]) {
    const out = html(state)
    expect(out).toContain('role="alert"')
    expect(out).not.toContain('token=signed')
    expect(out).not.toContain('Yesterday')
  }
})
it('announces a pending bounded reference lookup', () => {
  expect(html({})).toContain('role="status"')
})
