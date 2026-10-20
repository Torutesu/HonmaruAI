import { parseDocument, stringify } from 'yaml';
import { MAX_SKILL_CHARS, cleanSkillMetadata } from './skills.js';

export const MAX_SKILL_FILE_BYTES = 65536;
export function parseSkillMarkdown(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > MAX_SKILL_FILE_BYTES) return { error: 'SKILL.md must be at most 64 KiB.' };
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const front = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!front) return { error: 'Start SKILL.md with YAML frontmatter containing name and description.' };
  let fields;
  try {
    const document = parseDocument(front[1], { uniqueKeys: true, strict: true, prettyErrors: false });
    if (document.errors.length || document.warnings.length) return { error: 'Invalid YAML frontmatter.' };
    fields = document.toJS({ maxAliasCount: 0 });
  } catch { return { error: 'Invalid YAML frontmatter. Aliases and custom tags are not supported.' }; }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { error: 'Frontmatter must be a mapping.' };
  const { name, description, ...metadata } = fields;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) return { error: 'The skill name must contain 1–80 characters.' };
  if (typeof description !== 'string' || !description.trim() || description.trim().length > 200) return { error: 'The description must contain 1–200 characters.' };
  const body = text.slice(front[0].length).trim();
  if (!body || body.length > MAX_SKILL_CHARS) return { error: `The skill instructions must contain 1–${MAX_SKILL_CHARS} characters.` };
  const checked = cleanSkillMetadata(metadata);
  if (checked.error) return checked;
  return { draft: { name: name.trim(), description: description.trim(), body, metadata: checked.metadata } };
}

export function skillMarkdown(skill) {
  return `---\n${stringify({ ...(skill.metadata || {}), name: skill.name, description: skill.description || '' }, { lineWidth: 0 })}---\n\n${skill.body}\n`;
}
