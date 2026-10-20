import { expect, test } from 'vitest'
import { skillImportInput } from './skillImport'

test('folder encoding retains paths and binary bytes; ZIP stays a single archive', async () => {
  const bytes = new Uint8Array([0, 255, 128])
  const file = { name: 'image.bin', webkitRelativePath: 'skill/assets/image.bin', size: 3, arrayBuffer: async () => bytes.buffer } as File
  expect(await skillImportInput([file], true)).toEqual({ files: [{ path: 'skill/assets/image.bin', base64: 'AP+A' }] })
  expect(await skillImportInput([{ ...file, name: 'skill.zip' } as File])).toEqual({ zipBase64: 'AP+A' })
})
test('rejects oversized folders and multiple dropped files before reading bytes', async () => {
  const file = { name: 'SKILL.md', size: 1024 * 1024 + 1 } as File
  await expect(skillImportInput([file], true)).rejects.toThrow('1 MiB')
  await expect(skillImportInput([file, file])).rejects.toThrow('one')
  await expect(skillImportInput(Array(65).fill({ size: 0 }), true)).rejects.toThrow('64 files')
})

import { skillDropInput } from './skillImport'
import { vi } from 'vitest'
function fileEntry(name: string, content: number[]) {
  return { name, isFile: true, isDirectory: false, file: (done: (file: File) => void) => done({ size: content.length, arrayBuffer: async () => new Uint8Array(content).buffer } as File) }
}
function directory(name: string, batches: unknown[][]) {
  return { name, isFile: false, isDirectory: true, createReader: () => { let at = 0; return { readEntries: (done: (items: unknown[]) => void) => done(batches[at++] || []) } } }
}
function transfer(entry: unknown) { return { items: [{ webkitGetAsEntry: () => entry }], files: [] } as unknown as DataTransfer }
test('a dropped directory reads all directory batches and retains nested paths and binary bytes', async () => {
  const root = directory('package', [[fileEntry('SKILL.md', [65])], [directory('assets', [[fileEntry('image.bin', [0,255,128])]])]])
  expect(await skillDropInput(transfer(root))).toEqual({files:[{path:'package/SKILL.md',base64:'QQ=='},{path:'package/assets/image.bin',base64:'AP+A'}]})
})
test('oversized directory traversals and stalled permission callbacks are bounded', async () => {
  const root = directory('package', [Array.from({length:129},(_,i)=>directory(String(i),[]))])
  await expect(skillDropInput(transfer(root))).rejects.toThrow('large or complex')
  vi.useFakeTimers()
  try {
    const stalled = directory('package',[])
    stalled.createReader = () => ({readEntries: () => {}})
    const failed = expect(skillDropInput(transfer(stalled))).rejects.toThrow('Could not read')
    await vi.advanceTimersByTimeAsync(10000)
    await failed
  } finally {vi.useRealTimers()}
})
