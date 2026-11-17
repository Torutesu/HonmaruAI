import { describe, it, expect, beforeEach, vi } from 'vitest'
import { rankPlaces, emptyQueryPlaces, pushRecent, placesFrom, placesFallback, loadRecent, rememberRecent } from './places'
import type { Place } from './places'

const ch = (slug: string, extra: Partial<Place> = {}): Place => ({ view: `b:${slug}`, kind: 'channel', name: slug, handle: slug, ...extra })
const dm = (ref: string, name: string, extra: Partial<Place> = {}): Place => ({ view: `dm:${ref}`, kind: 'person', name, ...extra })
const views = (list: Place[]) => list.map((p) => p.view)

const team: Place[] = [
  ch('general'),
  ch('design-reviews'),
  ch('sales'),
  ch('sales-eu'),
  ch('engineering'),
  dm('r1', 'Kenji Tanaka', { handle: 'kenji' }),
  dm('r2', 'Genevieve Roy', { handle: 'gen' }),
  { view: 'g:abc', kind: 'group', name: 'Kenji Tanaka, Genevieve Roy' },
  { view: 'ag:7', kind: 'agent', name: 'Hayao', handle: 'hayao' },
]

// ⌘K finds a conversation by a few letters of its name.
describe('rankPlaces', () => {
  it('puts a name that starts with the letters before a word in it, before one that only contains them', () => {
    const places = [ch('the-general-store'), ch('regenerate'), ch('general')]
    expect(views(rankPlaces(places, 'gen', []))).toEqual(['b:general', 'b:the-general-store', 'b:regenerate'])
  })

  it('finds letters in order from the start of a word, as a last resort', () => {
    expect(views(rankPlaces(team, 'gnrl', []))).toEqual(['b:general'])
    // Not from the middle of a word: two letters would find every name.
    expect(views(rankPlaces([ch('marketing')], 'rk', []))).toEqual(['b:marketing'])
    expect(views(rankPlaces([ch('marketing')], 'ktg', []))).toEqual([])
  })

  it('tolerates one extra or mistyped letter in Room names only when Workspace Find opts in', () => {
    const rooms = [ch('planning', { name: 'Planning room' }), ch('general')]
    expect(views(rankPlaces(rooms, '#plannning', []))).toEqual([])
    expect(views(rankPlaces(rooms, '#plannning', [], 8, true))).toEqual(['b:planning'])
    expect(views(rankPlaces(rooms, '#plannxng', [], 8, true))).toEqual(['b:planning'])
    expect(views(rankPlaces(rooms, '#plx', [], 8, true))).toEqual([])
    // The opt-in never widens DM or Agent matching.
    expect(views(rankPlaces([{ view: 'dm:r1', kind: 'person', name: 'Planning room' }], 'plannxng', [], 8, true))).toEqual([])
  })

  it('reads a handle as well as a name, and an exact name first', () => {
    expect(views(rankPlaces(team, 'kenji', [])).slice(0, 1)).toEqual(['dm:r1'])
    expect(views(rankPlaces(team, '@hayao', []))).toEqual(['ag:7'])
    expect(views(rankPlaces(team, 'sales', []))).toEqual(['b:sales', 'b:sales-eu'])
  })

  it('breaks a tie with mentions, then what is unread, then what you opened last', () => {
    const places = [ch('ops-a'), ch('ops-b', { fresh: true }), ch('ops-c', { mentions: 2 }), ch('ops-d', { unread: 1 }), ch('ops-e')]
    expect(views(rankPlaces(places, 'ops', ['b:ops-e']))).toEqual(['b:ops-c', 'b:ops-d', 'b:ops-b', 'b:ops-e', 'b:ops-a'])
    // A better match still wins over a louder one.
    expect(views(rankPlaces([ch('devops', { mentions: 5 }), ch('ops')], 'ops', []))[0]).toBe('b:ops')
  })

  it('looks only at channels after #, and only at people and agents after @', () => {
    expect(views(rankPlaces(team, '#gen', []))).toEqual(['b:general'])
    // A group DM has no @handle: "Kenji Tanaka, Genevieve Roy" is not @gen.
    expect(views(rankPlaces(team, '@gen', []))).toEqual(['dm:r2'])
    expect(views(rankPlaces(team, '@', [])).sort()).toEqual(['ag:7', 'dm:r1', 'dm:r2'])
    // Typed on a Japanese keyboard, the full-width marks mean the same.
    expect(views(rankPlaces(team, '＃ｇｅｎ', []))).toEqual(['b:general'])
  })

  it('lists every channel for a lone #, the one you were in last and then what calls for you first', () => {
    const out = rankPlaces([...team, ch('zeta', { unread: 3 })], '#', ['b:sales'])
    expect(views(out).slice(0, 2)).toEqual(['b:sales', 'b:zeta'])
    expect(out.every((p) => p.kind === 'channel')).toBe(true)
    expect(out).toHaveLength(6)
  })

  it('stops at the limit, and finds nothing for letters nobody has', () => {
    const many = Array.from({ length: 20 }, (_, i) => ch(`team-${i}`))
    expect(rankPlaces(many, 'team', [])).toHaveLength(8)
    expect(rankPlaces(many, 'team', [], 3)).toHaveLength(3)
    expect(rankPlaces(team, 'xyzzy', [])).toEqual([])
  })

  it('matches a name in Japanese by any part of it', () => {
    const places = [ch('eigyo', { name: '営業チーム' }), ch('kaihatsu', { name: '開発' })]
    expect(views(rankPlaces(places, 'チーム', []))).toEqual(['b:eigyo'])
    expect(views(rankPlaces(places, 'eig', []))).toEqual(['b:eigyo'])
  })
})

describe('emptyQueryPlaces', () => {
  it('lists the one before first, then what asks for you, then where you were, then what is new, and nothing else', () => {
    const places = [ch('a'), ch('b', { fresh: true }), ch('c'), ch('d', { mentions: 1 }), ch('e', { unread: 2 }), ch('f')]
    expect(views(emptyQueryPlaces(places, ['b:f', 'b:d', 'b:a']))).toEqual(['b:f', 'b:d', 'b:e', 'b:a', 'b:b'])
  })

  it('keeps the way back first when every channel has something new', () => {
    const busy = Array.from({ length: 10 }, (_, i) => ch(`busy-${i}`, { fresh: true }))
    const out = views(emptyQueryPlaces([...busy, ch('a'), ch('b')], ['b:a', 'b:b']))
    // ⌘K then Enter: the conversation before this one, not the loudest.
    expect(out.slice(0, 2)).toEqual(['b:a', 'b:b'])
    expect(out).toHaveLength(8)
    expect(out.slice(2)).toEqual(busy.slice(0, 6).map((p) => p.view))
  })

  it('puts no more than four that ask for you before where you were', () => {
    const asking = Array.from({ length: 6 }, (_, i) => ch(`ask-${i}`, { mentions: 6 - i }))
    const out = views(emptyQueryPlaces([...asking, ch('a'), ch('b')], ['b:a', 'b:b']))
    expect(out).toEqual(['b:a', 'b:ask-0', 'b:ask-1', 'b:ask-2', 'b:ask-3', 'b:b', 'b:ask-4', 'b:ask-5'])
  })

  it('does not count the one before among the four when it asks for you too', () => {
    const asking = Array.from({ length: 6 }, (_, i) => ch(`ask-${i}`, { unread: 1 }))
    const out = views(emptyQueryPlaces(asking, ['b:ask-5']))
    expect(out.slice(0, 5)).toEqual(['b:ask-5', 'b:ask-0', 'b:ask-1', 'b:ask-2', 'b:ask-3'])
  })

  it('skips a recent view that is no longer a place, and keeps to the limit', () => {
    expect(views(emptyQueryPlaces([ch('a'), ch('b')], ['b:gone', 'b:b', 'b:a'], 1))).toEqual(['b:b'])
    expect(emptyQueryPlaces([ch('a')], [])).toEqual([])
  })

  it('lists each place once, even when the stored list names it twice', () => {
    expect(views(emptyQueryPlaces([ch('a'), ch('b')], ['b:a', 'b:b', 'b:a']))).toEqual(['b:a', 'b:b'])
  })
})

describe('pushRecent', () => {
  it('moves the view opened to the front, once, and keeps ten', () => {
    expect(pushRecent(['b:a', 'b:b', 'b:c'], 'b:b')).toEqual(['b:b', 'b:a', 'b:c'])
    expect(pushRecent([], 'b:a')).toEqual(['b:a'])
    const ten = Array.from({ length: 10 }, (_, i) => `b:${i}`)
    expect(pushRecent(ten, 'b:new')).toEqual(['b:new', ...ten.slice(0, 9)])
    expect(pushRecent(ten, 'b:x', 3)).toEqual(['b:x', 'b:0', 'b:1'])
  })
})

describe('where you were lately, per workspace', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
  })

  it('is kept apart for each workspace, newest first', () => {
    rememberRecent('org-1', 'b:general')
    rememberRecent('org-1', 'dm:r1')
    rememberRecent('org-2', 'b:sales')
    expect(loadRecent('org-1')).toEqual(['dm:r1', 'b:general'])
    expect(loadRecent('org-2')).toEqual(['b:sales'])
    expect(localStorage.getItem('palette.recent:org-1')).toBe('["dm:r1","b:general"]')
  })

  it('reads anything unreadable as nothing', () => {
    localStorage.setItem('palette.recent:org-1', '{nope')
    expect(loadRecent('org-1')).toEqual([])
    localStorage.setItem('palette.recent:org-1', '[1,"b:a",null]')
    expect(loadRecent('org-1')).toEqual(['b:a'])
    vi.stubGlobal('localStorage', undefined)
    expect(loadRecent('org-1')).toEqual([])
    expect(() => rememberRecent('org-1', 'b:a')).not.toThrow()
  })
})

describe('placesFrom', () => {
  it('keeps the conversations with somewhere to open, with their mentions', () => {
    const out = placesFrom([
      { kind: 'channel', view: 'b:ops', name: 'Ops', handle: 'ops', private: true, unread: 1 },
      { kind: 'person', view: 'dm:r1', name: 'Kenji', handle: null, unread: 0, fresh: true },
      { kind: 'person', name: 'Former teammate', unread: 2 },
      { kind: 'app', name: 'Gmail', unread: 4 },
      { kind: 'agent', view: 'ag:7', name: 'Hayao', handle: 'hayao', unread: 0 },
    ], { 'b:ops': 2 })
    expect(out).toEqual([
      { view: 'b:ops', kind: 'channel', name: 'Ops', handle: 'ops', private: true, unread: 1, mentions: 2, fresh: false },
      { view: 'dm:r1', kind: 'person', name: 'Kenji', unread: 0, mentions: 0, fresh: true },
      { view: 'ag:7', kind: 'agent', name: 'Hayao', handle: 'hayao', unread: 0, mentions: 0, fresh: false },
    ])
  })
})

describe('placesFallback', () => {
  it('knows the channels and a DM with everyone but you', () => {
    const out = placesFallback(
      [{ slug: 'general', name: 'General' }, { slug: 'board', name: 'Board', private: true }],
      [{ ref: 'me', name: 'Me', mine: true }, { ref: 'r1', name: 'Kenji', handle: 'kenji' }, { ref: 'r2', name: 'Ana', handle: null }],
    )
    expect(out).toEqual([
      { view: 'b:general', kind: 'channel', name: 'General', handle: 'general' },
      { view: 'b:board', kind: 'channel', name: 'Board', handle: 'board', private: true },
      { view: 'dm:r1', kind: 'person', name: 'Kenji', handle: 'kenji' },
      { view: 'dm:r2', kind: 'person', name: 'Ana' },
    ])
  })
})
