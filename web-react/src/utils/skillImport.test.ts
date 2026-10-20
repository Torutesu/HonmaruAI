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
