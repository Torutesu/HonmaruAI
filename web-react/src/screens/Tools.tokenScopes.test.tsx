import React from 'react'
import { create } from 'react-test-renderer'
import { expect, test } from 'vitest'
import { AgentTokenScopes } from './Tools'

const translate = (value: string) => value

test('invalid token permissions are visible without misleading permission chips', () => {
  const tree = create(<AgentTokenScopes scopes={[]} invalidScopes translate={translate} />)
  expect(tree.root.findByProps({ role: 'status' }).children.join('')).toContain('Permissions cannot be read')
  expect(tree.root.findAllByType('i')).toHaveLength(0)
})

test('normal permissions and legacy missing-list display remain intact', () => {
  const read = create(<AgentTokenScopes scopes={['read']} translate={translate} />)
  expect(read.root.findAllByType('i').map(chip => chip.props['data-scope'])).toEqual(['read'])
  const legacy = create(<AgentTokenScopes translate={translate} />)
  expect(legacy.root.findAllByType('i').map(chip => chip.props['data-scope'])).toEqual(['read', 'write'])
})
