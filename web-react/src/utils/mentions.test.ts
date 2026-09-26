import { describe, it, expect } from 'vitest'
import { mentionQuery, matchMembers, insertMention, mentionedRefs, splitMentions, mentionKind, mentionSegments } from './mentions'

const team = [
  { ref: 'r1', name: 'Toru Bando' },
  { ref: 'r2', name: 'Mika Sato', aliases: ['美香'] },
  { ref: 'r3', name: 'Kenji' },
]

describe('mentions', () => {
  it('knows when the caret is inside an @', () => {
    expect(mentionQuery('ask @Mi', 7)).toEqual({ start: 4, query: 'Mi' })
    expect(mentionQuery('ask @Mika to', 12)).toBeNull()
    expect(mentionQuery('mail toru@x.jp', 14)).toBeNull()
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('offers the team, best match first', () => {
    expect(matchMembers(team, 'mi').map((m) => m.ref)).toEqual(['r2'])
    expect(matchMembers(team, 'sato').map((m) => m.ref)).toEqual(['r2'])
    expect(matchMembers(team, '美').map((m) => m.ref)).toEqual(['r2'])
    expect(matchMembers(team, '').map((m) => m.ref)).toEqual(['r3', 'r2', 'r1'])
    expect(matchMembers(team, 'zzz')).toEqual([])
  })

  it('puts the name in and moves the caret past it', () => {
    expect(insertMention('ask @Mi please', 7, team[1])).toEqual({ text: 'ask @Mika  please', caret: 10 })
  })

  it('reads the refs of whoever was named, by first name, full name or alias', () => {
    expect(mentionedRefs('@Mika and @Toru: look. @美香 too, @nobody not', team)).toEqual(['r2', 'r1'])
    expect(mentionedRefs('nothing here', team)).toEqual([])
  })

  it('splits a line so each @Name can be drawn', () => {
    expect(splitMentions('hi @Mika, and @Kenji')).toEqual([
      { text: 'hi ', mention: false }, { text: '@Mika', mention: true },
      { text: ', and ', mention: false }, { text: '@Kenji', mention: true },
    ])
  })
})

describe('usernames', () => {
  const team = [
    { ref: 'r1', name: 'Mika Sato', handle: 'mikas' },
    { ref: 'r2', name: 'Kenji', handle: null },
  ]
  it('finds a person by username and writes the username', () => {
    expect(matchMembers(team, 'mik').map((m) => m.ref)).toEqual(['r1'])
    expect(insertMention('ask @mi', 7, team[0]).text).toBe('ask @mikas ')
    // No username: the first name, as before.
    expect(insertMention('ask @ke', 7, team[1]).text).toBe('ask @Kenji ')
  })
  it('reads a username back out of a sentence', () => {
    expect(mentionedRefs('@mikas approve the price', team)).toEqual(['r1'])
    expect(mentionedRefs('@Mika approve the price', team)).toEqual(['r1'])
  })
})


describe('mentionKind', () => {
  const list = [
    { ref: '__ai', name: 'AI' },
    { ref: 'm1', name: 'Mika Sato', handle: 'mika' },
    { ref: 'group:sales', name: 'Sales', handle: 'sales' },
    { ref: 'agent:a1', name: 'Hayao', handle: 'hayao' },
  ]
  it('names who a mention reaches, and nobody for a name nobody has', () => {
    expect(mentionKind('@AI', list)).toBe('ai')
    expect(mentionKind('@mika', list)).toBe('person')
    expect(mentionKind('@Mika', list)).toBe('person')
    expect(mentionKind('@sales', list)).toBe('group')
    expect(mentionKind('@hayaoに', list)).toBe('agent')
    expect(mentionKind('＠hayao', list)).toBe('agent')
    expect(mentionKind('@nobody', list)).toBeNull()
  })
  it('cuts a text into runs that join back exactly', () => {
    const text = '@mika and @nobody, ask @hayaoに'
    const parts = mentionSegments(text, list)
    expect(parts.map((p) => p.text).join('')).toBe(text)
    expect(parts.filter((p) => p.mention).map((p) => [p.text, p.kind])).toEqual([['@mika', 'person'], ['@nobody', null], ['@hayaoに', 'agent']])
    expect(mentionSegments('mail a@b.com', list).some((p) => p.mention)).toBe(false)
  })
})
