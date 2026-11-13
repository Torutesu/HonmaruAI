import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The fuses that would let another program run its own JavaScript as
// Honmaru (#963) are off in every build: the direct download, the Mac App
// Store and the Microsoft Store all extend electron-builder.yml.
const read = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')

describe('Electron fuses', () => {
  const base = read('electron-builder.yml')
  const block = /^electronFuses:\n((?: {2}\w+: \w+\n)+)/m.exec(base)?.[1] || ''
  const fuses = Object.fromEntries(block.trim().split('\n').map((l) => l.trim().split(': ')))
  it('turns off run-as-node, NODE_OPTIONS and --inspect', () => {
    expect(fuses).toMatchObject({ runAsNode: 'false', enableNodeOptionsEnvironmentVariable: 'false', enableNodeCliInspectArguments: 'false' })
  })
  it('is inherited by the store builds, which do not turn them back on', () => {
    for (const name of ['electron-builder.mas.yml', 'electron-builder.store.yml']) {
      const config = read(name)
      expect(config).toMatch(/^extends: \.\/electron-builder\.yml$/m)
      expect(config).not.toMatch(/electronFuses|runAsNode|enableNode/)
    }
  })
  it('no code relies on running as Node', () => {
    for (const file of ['src/main.js']) expect(read(file)).not.toMatch(/ELECTRON_RUN_AS_NODE|child_process\.fork|\.fork\(/)
  })
})
