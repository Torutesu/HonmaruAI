import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildCsp, withCsp, INLINE_SCRIPT_HASHES } from '../src/csp.js'

const APP = 'https://app.honmaruai.com'
const API = 'https://tiktokforwork.torubj0904.workers.dev'

/// The policy as { directive: [sources] }.
const parse = (policy) => Object.fromEntries(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]))

describe('the policy on the app\'s pages', () => {
  const csp = parse(buildCsp({ apiOrigins: [API] }))

  it('runs only the app\'s own scripts and the theme script, never eval or other inline code', () => {
    expect(csp['script-src']).toEqual(["'self'", ...INLINE_SCRIPT_HASHES.map((h) => `'${h}'`)])
    expect(Object.values(csp).flat()).not.toContain("'unsafe-inline'")
    expect(Object.values(csp).flat()).not.toContain("'unsafe-eval'")
    expect(csp['style-src']).toEqual(["'self'"])
    expect(csp['default-src']).toEqual(["'self'"])
    expect(csp['object-src']).toEqual(["'none'"])
    expect(csp['base-uri']).toEqual(["'self'"])
    expect(csp['frame-ancestors']).toEqual(["'none'"])
  })

  it('connects to the app, the API over https and the relay over wss, and nowhere else', () => {
    expect(csp['connect-src']).toEqual(["'self'", API, 'wss://tiktokforwork.torubj0904.workers.dev'])
  })

  it('takes every configured API origin, without repeating one', () => {
    const more = parse(buildCsp({ apiOrigins: [API, 'https://api.staging.example', API] }))
    expect(more['connect-src']).toEqual(["'self'", API, 'https://api.staging.example', 'wss://tiktokforwork.torubj0904.workers.dev', 'wss://api.staging.example'])
    expect(more['form-action']).toEqual(["'self'", API, 'https://api.staging.example'])
  })

  it('shows pictures from the API, pasted ones, and https sites; media from the API and blobs; frames only YouTube\'s player', () => {
    expect(csp['img-src']).toEqual(["'self'", API, 'data:', 'blob:', 'https:'])
    expect(csp['img-src']).not.toContain('http:')
    expect(csp['media-src']).toEqual(["'self'", API, 'https://media.honmaruai.com', 'blob:'])
    expect(csp['frame-src']).toEqual(['https://www.youtube-nocookie.com'])
  })

  it('lets Vite\'s dev server reload, only in development', () => {
    const local = parse(buildCsp({ apiOrigins: [API, 'http://localhost:8787'], dev: true }))
    expect(local['script-src']).toContain("'unsafe-inline'")
    expect(local['style-src']).toContain("'unsafe-inline'")
    expect(local['connect-src']).toEqual(expect.arrayContaining(['http://localhost:8787', 'ws://localhost:8787', 'ws://localhost:*']))
  })

  it('allows every inline script in web-react/index.html by its hash, so a change to one is caught here', () => {
    const file = fileURLToPath(new URL('../../../web-react/index.html', import.meta.url))
    if (!existsSync(file)) return
    const html = readFileSync(file, 'utf8')
    for (const [, body] of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      const hash = `sha256-${createHash('sha256').update(body).digest('base64')}`
      expect(INLINE_SCRIPT_HASHES).toContain(hash)
    }
  })
})

describe('which responses get it', () => {
  const policy = buildCsp({ apiOrigins: [API] })

  it('is added to the app\'s own responses', () => {
    expect(withCsp({ 'content-type': ['text/html'] }, `${APP}/c/x`, { appOrigin: APP, policy })).toEqual({
      'content-type': ['text/html'],
      'Content-Security-Policy': [policy],
    })
  })

  it('is added beside a policy the server sent, never in place of it', () => {
    const headers = withCsp({ 'content-security-policy': ["default-src 'none'"] }, `${APP}/`, { appOrigin: APP, policy })
    expect(headers).toEqual({ 'content-security-policy': ["default-src 'none'", policy] })
    expect(withCsp({ 'Content-Security-Policy': "img-src 'self'" }, `${APP}/`, { appOrigin: APP, policy })).toEqual({ 'Content-Security-Policy': ["img-src 'self'", policy] })
  })

  it('leaves every other site\'s responses alone', () => {
    const headers = { 'content-type': ['text/html'] }
    expect(withCsp(headers, `${API}/auth/github`, { appOrigin: APP, policy })).toBe(headers)
    expect(withCsp(headers, 'https://app.honmaruai.com.evil.example/', { appOrigin: APP, policy })).toBe(headers)
    expect(withCsp(headers, 'not a url', { appOrigin: APP, policy })).toBe(headers)
  })
})
