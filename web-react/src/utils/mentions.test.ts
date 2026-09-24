import { describe, it, expect } from 'vitest'
import { mentionQuery, matchMembers, insertMention, mentionedRefs, splitMentions } from './mentions'

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
