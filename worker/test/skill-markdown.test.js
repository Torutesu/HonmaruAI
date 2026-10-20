import { expect, test } from 'vitest';
import { parseSkillMarkdown, skillMarkdown } from '../src/harness/skillMarkdown.js';

const source = `---
name: weekly-report
description: >
  Prepare the weekly report
  using the agreed sources.
allowed-tools: [read_file]
metadata:
  owner: team
---

# Weekly report
Read the agreed sources, then draft the report.

---
Do not invent metrics.
`;
test('imports multiline frontmatter and preserves additional metadata through export', () => {
  const { draft } = parseSkillMarkdown('\uFEFF' + source.replace(/\n/g, '\r\n'));
  expect(draft).toMatchObject({ name: 'weekly-report', description: 'Prepare the weekly report using the agreed sources.',
    metadata: { 'allowed-tools': ['read_file'], metadata: { owner: 'team' } } });
  expect(draft.body).toContain('---\nDo not invent metrics.');
  expect(parseSkillMarkdown(skillMarkdown(draft)).draft).toEqual(draft);
});
test.each([
  '# Missing frontmatter',
  '---\nname: test\n---\nBody',
  '---\nname: 42\ndescription: test\n---\nBody',
  '---\nname: test\nname: duplicate\ndescription: test\n---\nBody',
  '---\nname: test\ndescription: !unknown tag\n---\nBody',
  '---\nname: &name test\ndescription: *name\n---\nBody',
  '---\nname: test\ndescription: test\n---\n',
  '---\nname: test\ndescription: test\n---\n' + 'a'.repeat(8001),
  'a'.repeat(65537),
])('rejects invalid or oversized files without creating a partial draft (%#)', input => {
  expect(parseSkillMarkdown(input)).toHaveProperty('error');
  expect(parseSkillMarkdown(input).draft).toBeUndefined();
});
test('untrusted fields remain metadata, never import identity or permissions', () => {
  const { draft } = parseSkillMarkdown('---\nname: test\ndescription: test\nid: another-skill\nvisibility: workspace\ncreatedBy: admin\n---\nBody');
  expect(draft.id).toBeUndefined();
  expect(draft.visibility).toBeUndefined();
  expect(draft.metadata).toEqual({ id: 'another-skill', visibility: 'workspace', createdBy: 'admin' });
});
