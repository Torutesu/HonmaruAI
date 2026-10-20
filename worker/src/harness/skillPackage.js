import { parseSkillMarkdown } from './skillMarkdown.js';

export const MAX_SKILL_PACKAGE_FILES = 64;
export const MAX_SKILL_PACKAGE_BYTES = 8 * 1024 * 1024;
export const MAX_SKILL_ASSET_BYTES = 1024 * 1024;

// One portable relative path format for folder, ZIP, export and agent reads.
// Reject ambiguous paths rather than silently rewriting the requested file.
export function skillPackagePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value !== value.normalize('NFC')
    || /[\\\x00-\x1f\x7f:]/.test(value) || value.startsWith('/') || value.endsWith('/')) return null;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  return value;
}

/** Decoder output only: callers must bound ZIP expansion before allocation. */
export function validateSkillPackage(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_SKILL_PACKAGE_FILES) return {error:'A skill package must contain 1–64 files.'};
  const paths = new Set(), files = [];
  let total = 0;
  for (const entry of entries) {
    const path = skillPackagePath(entry?.path);
    if (!path || entry?.kind && entry.kind !== 'file' || !(entry?.bytes instanceof Uint8Array)) return {error:'A package contains an invalid path, link or file.'};
    const key = path.toLowerCase();
    if (paths.has(key)) return {error:'A package contains duplicate file paths.'};
    paths.add(key);
    total += entry.bytes.byteLength;
    if (entry.bytes.byteLength > MAX_SKILL_ASSET_BYTES || total > MAX_SKILL_PACKAGE_BYTES) return {error:'A package exceeds the file or total size limit.'};
    files.push({path,bytes:entry.bytes});
  }
  // A file cannot also be the directory containing another file.
  for (const path of paths) {
    const segments = path.split('/');segments.pop();
    while (segments.length) { if (paths.has(segments.join('/'))) return {error:'A file conflicts with a package directory.'};segments.pop(); }
  }
  const root = files.find(file => file.path === 'SKILL.md');
  if (!root) return {error:'Place exactly one SKILL.md at the package root.'};
  let markdown;
  try { markdown = new TextDecoder('utf-8',{fatal:true}).decode(root.bytes); }
  catch { return {error:'SKILL.md must contain valid UTF-8 text.'}; }
  const parsed = parseSkillMarkdown(markdown);
  if (parsed.error) return parsed;
  return {draft:parsed.draft,files:files.filter(file=>file!==root),totalBytes:total};
}
