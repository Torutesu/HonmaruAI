import { describe, expect, it } from 'vitest'
import { act, create } from 'react-test-renderer'
import { HarnessAppIcon } from './HarnessAppIcon'

describe('HarnessAppIcon', () => {
  it.each([
    ['grid', 'grid'],
    ['workflow', 'workflow'],
    ['📊', 'insights'],
    ['unknown-icon', 'list-check'],
  ])('renders %s as the %s icon', (icon, expected) => {
    let tree!: ReturnType<typeof create>
    act(() => { tree = create(<HarnessAppIcon icon={icon} />) })
    expect(tree.root.findByType('svg').props['data-icon']).toBe(expected)
    act(() => tree.unmount())
  })
})
