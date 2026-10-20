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

// Capture the dropped entries while the event's DataTransfer is available.
// Directory reads are bounded by entry count, byte count and one deadline.
export async function skillDropInput(transfer: DataTransfer, t: (message: string) => string = message => message): Promise<SkillImportInput> {
  const entries = Array.from(transfer.items || []).map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry)
  if (!entries.some(entry => entry.isDirectory)) return skillImportInput(Array.from(transfer.files), false, t)
  const deadline = Date.now() + 10000
  const files: Array<{ path: string; base64: string }> = []
  let visited = 0, total = 0
  const read = <T,>(start: (done: (value: T) => void, fail: (error: DOMException) => void) => void) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('Could not read the folder. Choose it again.'))), Math.max(0, deadline - Date.now()))
    try { start(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) }) }
    catch (error) { clearTimeout(timer); reject(error) }
  })
  const visit = async (entry: FileSystemEntry, parent = ''): Promise<void> => {
    if (++visited > 128 || Date.now() >= deadline) throw new Error(t('This folder is too large or complex. Choose a smaller skill package.'))
    const path = parent + entry.name
    if (entry.isFile) {
      const file = await read<File>((done, fail) => (entry as FileSystemFileEntry).file(done, fail))
      total += file.size
      if (files.length >= 64 || file.size > 1024 * 1024 || total > 8 * 1024 * 1024) throw new Error(t('A skill folder supports up to 64 files, 1 MiB per file and 8 MiB total.'))
      const bytes = await read<ArrayBuffer>((done, fail) => { void file.arrayBuffer().then(done, fail) })
      files.push({ path, base64: base64(new Uint8Array(bytes)) })
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const children = await read<FileSystemEntry[]>((done, fail) => reader.readEntries(done, fail))
        if (!children.length) break
        for (const child of children) await visit(child, path + '/')
      }
    } else throw new Error(t('Could not read the folder. Choose it again.'))
  }
  for (const entry of entries) await visit(entry)
  return { files }
}
