// The update feed every installed app reads (src/updates.js). electron-updater
// asks GitHub for the repository's latest release and reads its own
// platform's file from it — latest-mac.yml, latest.yml (Windows) or
// latest-linux.yml — with no fallback to an older release. A release marked
// latest without one leaves that platform unable to update: v1.3.5, built
// by the Mac workflow alone, failed every Windows and Linux app's check.
//
// So before a release is published: each platform's file it lacks is
// brought over, with the installers it names, from the newest published
// release that has one (`carry`) — that platform stays on the version it
// has, and moves on with the next release built for it — and publishing
// waits until every platform that has shipped has its file, and every file
// a feed names is there (`check`).
//
//   node scripts/feed.mjs carry v1.3.6
//   node scripts/feed.mjs check v1.3.6
//
// with GH_TOKEN, and GITHUB_REPOSITORY (owner/repo) as Actions sets it.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/// Each platform's feed file, and whose it is.
export const FEEDS = { 'latest-mac.yml': 'macOS', 'latest.yml': 'Windows', 'latest-linux.yml': 'Linux' }

const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2')

/// The release assets a feed file names: its files' urls and its path, as
/// the updater asks GitHub for them (a space as a dash).
export function feedAssets(text) {
  const names = new Set()
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:-\s+)?(?:url|path):\s*(.+?)\s*$/.exec(line)
    if (m) names.add(unquote(m[1]).replace(/ /g, '-'))
  }
  return [...names]
}

/// A release as far as the feed goes: `{ tag, draft, prerelease, assets }`,
/// `assets` being the names of its files.
const published = (r) => r && !r.draft && !r.prerelease

/// The platforms a release has to carry a feed file for: every one a
/// published release has carried — installed apps there read the feed —
/// and any it carries itself. `releases` are GitHub's, newest first.
export function requiredFeeds(releases, tag) {
  const self = releases.find((r) => r.tag === tag)
  return Object.keys(FEEDS).filter((name) => self?.assets.includes(name) || releases.some((r) => published(r) && r.assets.includes(name)))
}

/// Where each feed file the release lacks comes from: the newest published
/// release that has it. A platform no release has shipped is left out.
export function carryFrom(releases, tag) {
  const self = releases.find((r) => r.tag === tag)
  const out = {}
  for (const name of Object.keys(FEEDS)) {
    if (self?.assets.includes(name)) continue
    const source = releases.find((r) => r.tag !== tag && published(r) && r.assets.includes(name))
    if (source) out[name] = source.tag
  }
  return out
}

/// What stops the release from being published, as sentences: a feed file
/// it has to carry and does not, or a file one of its feed files names that
/// is not in it. `feeds` are the release's own feed files, by name, as text.
export function feedProblems({ assets, feeds, required }) {
  const have = new Set(assets)
  const problems = []
  for (const name of required) {
    if (!have.has(name)) problems.push(`${name} is missing: ${FEEDS[name]} apps could not check for updates.`)
  }
  for (const [name, text] of Object.entries(feeds)) {
    const named = feedAssets(text)
    if (!named.length) problems.push(`${name} names no installer.`)
    for (const file of named) if (!have.has(file)) problems.push(`${name} names ${file}, which is not in the release.`)
  }
  return problems
}

// ---- Against GitHub, through the gh command line ----

const gh = (args, options = {}) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })

function releases(repo) {
  const list = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100`]))
  return list.map((r) => ({ tag: r.tag_name, draft: r.draft, prerelease: r.prerelease, assets: (r.assets || []).map((a) => a.name) }))
}

function download(tag, names, dir, repo) {
  if (!names.length) return
  gh(['release', 'download', tag, '--repo', repo, '--dir', dir, '--clobber', ...names.flatMap((n) => ['--pattern', n])])
}

function carry(tag, repo) {
  const all = releases(repo)
  if (!all.some((r) => r.tag === tag)) throw new Error(`There is no release ${tag}.`)
  const plan = carryFrom(all, tag)
  if (!Object.keys(plan).length) { console.log(`${tag} has every platform's feed that has shipped.`); return }
  for (const [name, from] of Object.entries(plan)) {
    const source = all.find((r) => r.tag === from)
    const dir = mkdtempSync(path.join(tmpdir(), 'honmaru-feed-'))
    try {
      download(from, [name], dir, repo)
      const named = feedAssets(readFileSync(path.join(dir, name), 'utf8'))
      // Blockmaps let the updater fetch only what changed; without them it
      // downloads the whole installer, so they come along when there are any.
      const files = [...named, ...named.map((n) => `${n}.blockmap`).filter((n) => source.assets.includes(n))]
      const absent = named.filter((n) => !source.assets.includes(n))
      if (absent.length) throw new Error(`${from}'s ${name} names ${absent.join(', ')}, which it does not have.`)
      download(from, files, dir, repo)
      // The feed goes up last: it never names a file not yet there.
      gh(['release', 'upload', tag, '--repo', repo, '--clobber', ...files.map((n) => path.join(dir, n))], { stdio: 'inherit' })
      gh(['release', 'upload', tag, '--repo', repo, '--clobber', path.join(dir, name)], { stdio: 'inherit' })
      console.log(`${tag}: ${FEEDS[name]} stays on ${from} (${name} and ${files.length === 1 ? '1 file' : `${files.length} files`} copied from it).`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function check(tag, repo) {
  const all = releases(repo)
  const self = all.find((r) => r.tag === tag)
  if (!self) throw new Error(`There is no release ${tag}.`)
  const dir = mkdtempSync(path.join(tmpdir(), 'honmaru-feed-'))
  try {
    const own = Object.keys(FEEDS).filter((n) => self.assets.includes(n))
    download(tag, own, dir, repo)
    const feeds = Object.fromEntries(own.map((n) => [n, readFileSync(path.join(dir, n), 'utf8')]))
    const problems = feedProblems({ assets: self.assets, feeds, required: requiredFeeds(all, tag) })
    if (problems.length) {
      console.error(`${tag} cannot be published:`)
      for (const p of problems) console.error(`  - ${p}`)
      process.exit(1)
    }
    console.log(`${tag} has the update for ${own.map((n) => FEEDS[n]).join(', ')}.`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, tag] = process.argv.slice(2)
  const repo = process.env.GITHUB_REPOSITORY || 'Torutesu/HonmaruAI'
  if (!tag || !['carry', 'check'].includes(command)) {
    console.error('Usage: node scripts/feed.mjs carry|check <tag>')
    process.exit(2)
  }
  try {
    if (command === 'carry') carry(tag, repo)
    else check(tag, repo)
  } catch (error) {
    console.error(error?.message || error)
    process.exit(1)
  }
}
