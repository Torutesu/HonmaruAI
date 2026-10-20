import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadMembers, membersHeld, forgetMembers } from './mentions'

const answer = (status: number, members: unknown[] = []) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ members }) })
const kenji = { ref: 'u2', name: 'Kenji Sato', handle: 'kenji', mine: false }
const me = { ref: 'u1', name: 'Anand Babu', handle: 'anand', mine: true }

// The team every box that offers names reads: an answer that is not the
// team is never kept as an empty one.
describe('loadMembers', () => {
  afterEach(() => { forgetMembers(); vi.unstubAllGlobals() })

  it('does not keep a refused read as a team of nobody, and reads again', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(answer(429)).mockResolvedValueOnce(answer(200, [me, kenji]))
    vi.stubGlobal('fetch', fetch)
    expect(await loadMembers('https://api', 'org', 't')).toEqual([])
    expect(membersHeld('https://api', 'org')).toBe(false)
    const team = await loadMembers('https://api', 'org', 't')
    expect(team.map((m) => m.handle)).toEqual(['anand', 'kenji'])
    expect(team[0].mine).toBe(true)
    expect(membersHeld('https://api', 'org')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the team it last read through a failed read after it', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(answer(200, [me, kenji]))
      .mockResolvedValueOnce(answer(503))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetch)
    await loadMembers('https://api', 'org', 't')
    forgetMembers('org')
    expect((await loadMembers('https://api', 'org', 't')).map((m) => m.ref)).toEqual(['u1', 'u2'])
    expect(membersHeld('https://api', 'org')).toBe(false)
    expect((await loadMembers('https://api', 'org', 't')).map((m) => m.ref)).toEqual(['u1', 'u2'])
  })

  it('shares one read between the boxes asking at once', async () => {
    const fetch = vi.fn().mockResolvedValue(answer(200, [kenji]))
    vi.stubGlobal('fetch', fetch)
    const [a, b] = await Promise.all([loadMembers('https://api', 'org', 't'), loadMembers('https://api', 'org', 't')])
    expect(a).toBe(b)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
