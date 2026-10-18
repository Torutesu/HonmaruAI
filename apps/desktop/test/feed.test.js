import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { carryFrom, feedAssets, feedProblems, requiredFeeds } from '../scripts/feed.mjs'

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const MAC = `version: 1.3.6
files:
  - url: Honmaru-AI-1.3.6-universal-mac.zip
    sha512: abc
    size: 1
  - url: Honmaru-AI-1.3.6-universal.dmg
    sha512: def
    size: 2
path: Honmaru-AI-1.3.6-universal-mac.zip
sha512: abc
releaseDate: '2026-10-01T00:00:00.000Z'
`
const WIN = `version: 1.3.4
files:
  - url: 'Honmaru AI Setup 1.3.4.exe'
    sha512: ghi
    size: 3
path: Honmaru AI Setup 1.3.4.exe
sha512: ghi
`

describe('what a feed file names', () => {
  it('is every installer it lists, as the updater asks GitHub for them', () => {
    expect(feedAssets(MAC)).toEqual(['Honmaru-AI-1.3.6-universal-mac.zip', 'Honmaru-AI-1.3.6-universal.dmg'])
    expect(feedAssets(WIN)).toEqual(['Honmaru-AI-Setup-1.3.4.exe'])
    expect(feedAssets(WIN.replace(/\n/g, '\r\n'))).toEqual(['Honmaru-AI-Setup-1.3.4.exe'])
    expect(feedAssets('')).toEqual([])
  })
})

// v1.3.5 came out of the Mac workflow alone and was marked latest; the
// updater reads only the latest release, so every Windows and Linux app's
// check failed (#345).
const history = [
  { tag: 'v1.3.6', draft: true, prerelease: false, assets: ['latest-mac.yml', 'Honmaru-AI-1.3.6-universal-mac.zip', 'Honmaru-AI-1.3.6-universal.dmg'] },
  { tag: 'v1.3.5', draft: false, prerelease: false, assets: ['latest-mac.yml', 'Honmaru-AI-1.3.5-universal-mac.zip'] },
  { tag: 'v1.3.5-beta', draft: false, prerelease: true, assets: ['latest-linux.yml', 'Honmaru-AI-1.3.5-beta.AppImage'] },
  { tag: 'v1.3.4', draft: false, prerelease: false, assets: ['latest-mac.yml', 'latest.yml', 'Honmaru-AI-Setup-1.3.4.exe', 'Honmaru-AI-Setup-1.3.4.exe.blockmap'] },
]

describe('a release built for some platforms only', () => {
  it('has to carry the feed of every platform a published release has shipped', () => {
    expect(requiredFeeds(history, 'v1.3.6')).toEqual(['latest-mac.yml', 'latest.yml'])
  })

  it('brings each one it lacks from the newest published release that has it', () => {
    expect(carryFrom(history, 'v1.3.6')).toEqual({ 'latest.yml': 'v1.3.4' })
  })

  it('does not take a prerelease\'s feed, or a draft\'s, nor ask for a platform never shipped', () => {
    const drafts = [{ tag: 'v2.0.0', draft: true, prerelease: false, assets: ['latest-mac.yml'] }, { tag: 'v1.9.9', draft: true, prerelease: false, assets: ['latest.yml'] }]
    expect(carryFrom(drafts, 'v2.0.0')).toEqual({})
    expect(requiredFeeds(drafts, 'v2.0.0')).toEqual(['latest-mac.yml'])
  })

  it('carries nothing for a release built for every platform', () => {
    const all = [{ tag: 'v1.4.0', draft: true, prerelease: false, assets: ['latest-mac.yml', 'latest.yml', 'latest-linux.yml'] }, ...history.slice(1)]
    expect(carryFrom(all, 'v1.4.0')).toEqual({})
  })
})

describe('whether a release may be published', () => {
  const assets = history[0].assets
  it('not while a platform that has shipped has no feed in it', () => {
    const problems = feedProblems({ assets, feeds: { 'latest-mac.yml': MAC }, required: ['latest-mac.yml', 'latest.yml'] })
    expect(problems).toEqual(['latest.yml is missing: Windows apps could not check for updates.'])
  })

  it('not while a feed names an installer it does not have', () => {
    const problems = feedProblems({ assets: ['latest-mac.yml', 'Honmaru-AI-1.3.6-universal-mac.zip'], feeds: { 'latest-mac.yml': MAC }, required: ['latest-mac.yml'] })
    expect(problems).toEqual(['latest-mac.yml names Honmaru-AI-1.3.6-universal.dmg, which is not in the release.'])
    expect(feedProblems({ assets: ['latest.yml'], feeds: { 'latest.yml': 'version: 1.0.0\n' }, required: [] })).toEqual(['latest.yml names no installer.'])
  })

  it('once every feed and everything it names is there', () => {
    const carried = [...assets, 'latest.yml', 'Honmaru-AI-Setup-1.3.4.exe', 'Honmaru-AI-Setup-1.3.4.exe.blockmap']
    expect(feedProblems({ assets: carried, feeds: { 'latest-mac.yml': MAC, 'latest.yml': WIN }, required: ['latest-mac.yml', 'latest.yml'] })).toEqual([])
  })
})

describe('the release workflows', () => {
  it('publish the Mac release only once the feed is complete', () => {
    const mac = read('../../../.github/workflows/mac-release.yml')
    const carry = mac.indexOf('node scripts/feed.mjs carry "v$VERSION"')
    const check = mac.indexOf('node scripts/feed.mjs check "v$VERSION"')
    const publish = mac.indexOf('gh release edit "v$VERSION" --draft=false --latest')
    expect(carry).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(carry)
    expect(publish).toBeGreaterThan(check)
  })

  it('leave every desktop draft with a complete feed before anyone publishes it', () => {
    const desktop = read('../../../.github/workflows/desktop-release.yml')
    expect(desktop).toMatch(/node scripts\/feed\.mjs carry "\$TAG"/)
    expect(desktop).toMatch(/node scripts\/feed\.mjs check "\$TAG"/)
  })
})
