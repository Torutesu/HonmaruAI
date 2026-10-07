#!/usr/bin/env node
// One version for every app (VERSION at the repository root): the Mac and
// Windows desktop app, the iPhone app, the Android app and the web client
// all say the same number, so "which version are you on" has one answer.
// Run by CI; fails naming each place that disagrees.

import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const json = (p) => JSON.parse(read(p))
const want = read('VERSION').trim()

const found = {
  'apps/desktop/package.json': json('apps/desktop/package.json').version,
  'apps/desktop/package-lock.json': json('apps/desktop/package-lock.json').version,
  'apps/mobile/app.json (expo.version)': json('apps/mobile/app.json').expo.version,
  'apps/mobile/package.json': json('apps/mobile/package.json').version,
  'web-react/package.json': json('web-react/package.json').version,
  'project.yml (MARKETING_VERSION)': read('project.yml').match(/MARKETING_VERSION:\s*"?([^"\n]+)"?/)?.[1],
}
for (const [i, m] of [...read('TikTokForWork.xcodeproj/project.pbxproj').matchAll(/MARKETING_VERSION = ([^;]+);/g)].entries()) {
  found[`project.pbxproj (MARKETING_VERSION #${i + 1})`] = m[1].replace(/"/g, '')
}

const wrong = Object.entries(found).filter(([, v]) => v !== want)
if (wrong.length) {
  console.error(`VERSION is ${want}, but:`)
  for (const [where, v] of wrong) console.error(`  ${where}: ${v ?? '(missing)'}`)
  process.exit(1)
}
console.log(`All apps at ${want}.`)
