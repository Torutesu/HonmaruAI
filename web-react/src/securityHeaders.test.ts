import { describe, it, expect } from 'vitest'
import indexHtml from '../index.html?raw'
import headers from '../public/_headers?raw'

// The page's Content-Security-Policy (public/_headers) lets index.html's one
// inline script run by its hash. Edit the script without the hash and the
// theme script is blocked in production while every test still passes, so
// the two are checked against each other here.

const csp = /Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? ''
const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? ''

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
}

describe('security headers', () => {
  it("allows each of index.html's inline scripts by its hash", async () => {
    const inline = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(inline.length).toBeGreaterThan(0)
    for (const script of inline) expect(directive('script-src')).toContain(`'sha256-${await sha256(script)}'`)
  })

  it('runs no script from anywhere but this origin', () => {
    expect(directive('script-src')).not.toMatch(/'unsafe-inline'|'unsafe-eval'|https:|\*/)
    expect(directive('object-src')).toBe("object-src 'none'")
  })

  it('cannot be framed by another site', () => {
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'")
    expect(headers).toMatch(/X-Frame-Options: DENY/)
  })
})
