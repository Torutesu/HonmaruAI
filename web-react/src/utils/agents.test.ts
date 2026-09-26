import { describe, expect, it } from 'vitest'
import { agentError, agentFileName, draftFromPreset, parseAgentFile } from './agents'
import { agentMentionables, agentsIn, matchMembers } from './mentions'

const t = (key: string, vars?: Record<string, string | number>) =>
  Object.entries(vars || {}).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), key)

describe('parseAgentFile', () => {
  it('reads front matter and keeps the rest as instructions', () => {
    const d = parseAgentFile('---\nname: Hayao\nhandle: "@hayao"\nemoji: 🎨\ndescription: "Art: direction"\nscope: personal\n---\n\n# Hayao\n\nYou direct art.\n')
    expect(d).toMatchObject({ name: 'Hayao', handle: 'hayao', emoji: '🎨', description: 'Art: direction', scope: 'personal', id: null })
    expect(d.instructions).toBe('# Hayao\n\nYou direct art.')
  })
  it('names a file with no front matter by its first heading', () => {
    const d = parseAgentFile('﻿# Secretary\r\n\r\nNotes.')
    expect(d.name).toBe('Secretary')
    expect(d.scope).toBe('team')
    expect(d.instructions).toBe('# Secretary\n\nNotes.')
  })
})

describe('agent helpers', () => {
  it('starts a preset as a team agent that remembers where it came from', () => {
    const d = draftFromPreset({ id: 'secretary', handle: 'secretary', emoji: '🗂️', name: 'Secretary', description: 'x', instructions: '# S' })
    expect(d).toMatchObject({ id: null, scope: 'team', preset: 'secretary', handle: 'secretary' })
  })
  it('says a taken @name so it can be changed', () => {
    expect(agentError('@hayao is already an agent here.', t)).toBe('@hayao is already an agent here. Try another @name.')
    expect(agentError('@sales is already a group.', t)).toBe('@sales is already a group. Try another @name.')
    expect(agentError('', t)).toBe('That did not save.')
  })
  it('names the download after the handle', () => {
    expect(agentFileName('hayao')).toBe('hayao.md')
    expect(agentFileName('../x')).toBe('..x.md')
    expect(agentFileName('')).toBe('agent.md')
  })
})

describe('agentMentionables', () => {
  const agents = [
    { id: 'a1', handle: 'hayao', name: 'Hayao', emoji: '🎨', description: 'Art director', scope: 'team' as const },
    { id: 'a2', handle: 'hayao', name: 'My Hayao', emoji: null, scope: 'personal' as const },
    { id: 'a3', handle: 'kenji', name: 'Kenji bot' },
  ]
  it('offers each agent once, by handle, with its face', () => {
    const list = agentMentionables(agents, [{ ref: 'm1', name: 'Kenji', handle: 'kenji' }])
    expect(list).toEqual([{ ref: 'agent:a1', name: 'Hayao', handle: 'hayao', title: 'Art director', agent: true, emoji: '🎨' }])
  })
  it('is found by what is typed after @', () => {
    const list = [{ ref: 'm1', name: 'Hanako' }, ...agentMentionables(agents)]
    expect(matchMembers(list, 'hay').map((m) => m.ref)).toEqual(['agent:a1'])
  })
})

describe('agentsIn', () => {
  it('reaches your own agents everywhere, and one added to a channel only there', () => {
    const agents = [
      { id: 'a1', handle: 'hayao', name: 'Hayao', channels: ['b:cafe'] },
      { id: 'a2', handle: 'menu', name: 'Menu', channels: ['b:cafe'], placed: true },
    ]
    expect(agentsIn(agents, 'b:cafe').map((a) => a.id)).toEqual(['a1', 'a2'])
    expect(agentsIn(agents, 'b:kitchen').map((a) => a.id)).toEqual(['a1'])
    expect(agentsIn(agents, null).map((a) => a.id)).toEqual(['a1'])
  })
})
