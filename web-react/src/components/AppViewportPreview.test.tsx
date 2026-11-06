import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import ja from '../utils/locales/ja'
import { AppViewportPreview } from './AppViewportPreview'

vi.mock('../utils/i18n',()=>({useT:()=> (key:string)=>key}))

test('switches the preview between desktop and phone widths accessibly', () => {
  const tree = create(<AppViewportPreview><iframe title="App preview" /></AppViewportPreview>)
  const desktop = tree.root.findByProps({ 'aria-label': 'Desktop preview' })
  const phone = tree.root.findByProps({ 'aria-label': 'Phone preview' })
  expect(desktop.props['aria-pressed']).toBe(true)
  expect(phone.props['aria-pressed']).toBe(false)
  act(() => phone.props.onClick())
  expect(phone.props['aria-pressed']).toBe(true)
  expect(desktop.props['aria-pressed']).toBe(false)
  expect(tree.root.findByProps({ 'data-viewport': 'phone' })).toBeTruthy()
  act(() => desktop.props.onClick())
  expect(tree.root.findByProps({ 'data-viewport': 'desktop' })).toBeTruthy()
})

test('Japanese dictionary covers responsive preview labels',()=>{
  expect(ja['Preview size']).toBe('プレビューサイズ')
  expect(ja['Desktop preview']).toBe('デスクトップ表示')
  expect(ja['Phone preview']).toBe('モバイル表示')
})
