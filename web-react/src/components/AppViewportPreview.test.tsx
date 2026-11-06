import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test } from 'vitest'
import { AppViewportPreview } from './AppViewportPreview'

test('switches the preview between desktop and phone widths accessibly', () => {
  const tree = create(<AppViewportPreview><iframe title="App preview" /></AppViewportPreview>)
  const desktop = tree.root.findByProps({ 'aria-label': 'デスクトップ表示' })
  const phone = tree.root.findByProps({ 'aria-label': 'モバイル表示' })
  expect(desktop.props['aria-pressed']).toBe(true)
  expect(phone.props['aria-pressed']).toBe(false)
  act(() => phone.props.onClick())
  expect(phone.props['aria-pressed']).toBe(true)
  expect(desktop.props['aria-pressed']).toBe(false)
  expect(tree.root.findByProps({ 'data-viewport': 'phone' })).toBeTruthy()
  act(() => desktop.props.onClick())
  expect(tree.root.findByProps({ 'data-viewport': 'desktop' })).toBeTruthy()
})
