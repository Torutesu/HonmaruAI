import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AppDeleteConfirm } from './AppDeleteConfirm'

vi.mock('../utils/i18n', () => ({ useT: () => (value: string) => value }))

test('app deletion confirmation explains workspace retention and exposes explicit actions', () => {
  const onDelete = vi.fn()
  const onKeep = vi.fn()
  let tree: ReturnType<typeof create>
  act(() => { tree = create(<AppDeleteConfirm onDelete={onDelete} onKeep={onKeep} />) })
  expect(JSON.stringify(tree!.toJSON())).toContain('This app will be hidden. Its database and data will remain until the workspace is deleted.')
  const buttons = tree!.root.findAllByType('button')
  expect(buttons.map(button => button.children.join(''))).toEqual(['Delete', 'Keep'])
  act(() => buttons[0].props.onClick())
  expect(onDelete).toHaveBeenCalledOnce()
  act(() => buttons[1].props.onClick())
  expect(onKeep).toHaveBeenCalledOnce()
  act(() => tree!.unmount())
})
