import { describe, expect, it, vi } from 'vitest'

// The guard in front of every request: a 401 asking for a recent sign-in is
// confirmed and sent again; one saying the workspace's rules ended the
// sign-in is announced; anything else passes through untouched.

describe('authGuard', () => {
  it('confirms and sends the same request again, announces a policy sign-out, and leaves the rest alone', async () => {
    const answers: Response[] = [
      new Response(JSON.stringify({ code: 'reauth-required' }), { status: 401 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
      new Response(JSON.stringify({ code: 'session-policy', orgId: 'team:x' }), { status: 401 }),
      new Response(JSON.stringify({ message: 'nope' }), { status: 401 }),
      new Response(JSON.stringify({ code: 'dlp-warning', rules: ['Card number'] }), { status: 409 }),
      new Response(JSON.stringify({ message: { id: 'm1' } }), { status: 201 }),
      new Response(JSON.stringify({ code: 'dlp-warning', rules: ['Card number'] }), { status: 409 }),
    ]
    const calls: string[] = []
    const bodies: Array<string | undefined> = []
    const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push(String(input)); bodies.push(init?.body as string | undefined); return answers.shift()! })
    // No DOM in these tests: a window is an EventTarget with fetch on it.
    const w = Object.assign(new EventTarget(), { fetch: fake as unknown as typeof fetch, location: { href: 'https://app.test/' } })
    ;(globalThis as unknown as { window: unknown }).window = w
    const { installAuthGuard } = await import('./authGuard')
    installAuthGuard()

    const asked: string[] = []
    window.addEventListener('honmaru:reauth', (e) => {
      e.preventDefault()
      const d = (e as CustomEvent<{ base: string; resolve: (ok: boolean) => void }>).detail
      asked.push(d.base)
      d.resolve(true)
    })
    const policy: Array<string | null> = []
    window.addEventListener('honmaru:session-policy', (e) => policy.push((e as CustomEvent<{ orgId: string | null }>).detail.orgId))

    const headers = { 'x-session-token': 'tok' }
    const first = await window.fetch('https://api.test/members/role', { method: 'PUT', headers, body: '{}' })
    expect(first.status).toBe(200)
    expect(asked).toEqual(['https://api.test'])
    expect(calls).toEqual(['https://api.test/members/role', 'https://api.test/members/role'])

    const second = await window.fetch('https://api.test/members?orgId=team:x', { headers })
    expect(second.status).toBe(401)
    expect(policy).toEqual(['team:x'])

    const third = await window.fetch('https://api.test/other', { headers })
    expect(third.status).toBe(401)
    expect(asked).toHaveLength(1)

    // A data rule warns: the person is asked; sending anyway sends it again,
    // acknowledged. Going back leaves the warning as the answer.
    let sendAnyway = true
    const warned: string[][] = []
    window.addEventListener('honmaru:dlp-warning', (e) => {
      e.preventDefault()
      const d = (e as CustomEvent<{ rules: string[]; resolve: (send: boolean) => void }>).detail
      warned.push(d.rules)
      d.resolve(sendAnyway)
    })
    const post = { method: 'POST', headers, body: JSON.stringify({ orgId: 'team:x', body: 'card' }) }
    const sent = await window.fetch('https://api.test/channels/messages', post)
    expect(sent.status).toBe(201)
    expect(JSON.parse(bodies[bodies.length - 1]!)).toEqual({ orgId: 'team:x', body: 'card', dlpAck: true })
    sendAnyway = false
    const kept = await window.fetch('https://api.test/channels/messages', post)
    expect(kept.status).toBe(409)
    expect(warned).toEqual([['Card number'], ['Card number']])
  })
})
