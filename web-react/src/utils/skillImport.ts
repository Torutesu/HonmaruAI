import type { SkillImportInput } from './harness'

function base64(bytes: Uint8Array) {
  let text = ''
  for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192))
  return btoa(text)
}

export async function skillImportInput(files: File[], folder = false, t: (message: string) => string = message => message): Promise<SkillImportInput> {
  if (!files.length) throw new Error(t('Choose a skill file or folder.'))
  if (!folder) {
    if (files.length !== 1) throw new Error(t('Choose one SKILL.md or ZIP file.'))
    const file = files[0]
    if (/\.md$/i.test(file.name) && file.size <= 65536) return await file.text()
    if (/\.zip$/i.test(file.name) && file.size <= 8 * 1024 * 1024 + 65536) return { zipBase64: base64(new Uint8Array(await file.arrayBuffer())) }
    throw new Error(t('Choose SKILL.md (up to 64 KiB) or ZIP (up to 8 MiB).'))
  }
  if (files.length > 64 || files.some(f => f.size > 1024 * 1024) || files.reduce((n, f) => n + f.size, 0) > 8 * 1024 * 1024) throw new Error(t('A skill folder supports up to 64 files, 1 MiB per file and 8 MiB total.'))
  return { files: await Promise.all(files.map(async file => ({ path: file.webkitRelativePath || file.name, base64: base64(new Uint8Array(await file.arrayBuffer())) }))) }
}
