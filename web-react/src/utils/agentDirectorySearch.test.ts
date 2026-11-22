import { describe, expect, test } from 'vitest'
import { agentMatchesDirectoryQuery, memberMatchesDirectoryQuery } from './agentDirectorySearch'

describe('directory search', () => {
  test('matches people and agents by name, handle, and specialty with NFKC normalization', () => {
    const person = { ref: 'u:1', name: 'Hanako Sato', handle: 'hanako', aliases: ['花子'], mine: false }
    const agent = { id: 'billing', name: 'Invoice reviewer', handle: 'invoice', specialty: '請求書の照合' }
    expect(memberMatchesDirectoryQuery(person, '花子')).toBe(true)
    expect(memberMatchesDirectoryQuery(person, 'HANAKO')).toBe(true)
    expect(agentMatchesDirectoryQuery(agent, '請求書')).toBe(true)
    expect(agentMatchesDirectoryQuery(agent, 'ＩＮＶＯＩＣＥ')).toBe(true)
    expect(agentMatchesDirectoryQuery(agent, 'customer')).toBe(false)
  })
})
