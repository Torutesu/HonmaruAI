import { expect, test } from 'vitest';
import { publicWorkflowInputPreview, workflowPreviewBytes, workflowStepInputPreview, MAX_RUN_PREVIEW_BYTES } from '../src/harness/workflowInputPreview.js';

test('input traces retain templates while removing runtime-shaped values and credentials recursively', () => {
  const preview = workflowStepInputPreview({
    type: 'connection', query: 'search {{input.query}}',
    args: { filter: '{{row.Status}}', api_token: 'top-secret', nested: { records: [{ customer: 'PRIVATE-CANARY' }] } },
  });
  expect(preview.input.query).toBe('search {{input.query}}');
  expect(preview.input.args.filter).toBe('{{row.Status}}');
  expect(preview.input.args.api_token).toBe('[REDACTED]');
  expect(preview.input.args.nested.records).toBe('[OMITTED: runtime data]');
  expect(JSON.stringify(preview)).not.toContain('PRIVATE-CANARY');
  expect(JSON.stringify(preview)).not.toContain('top-secret');
});

test('input preview caps each step and the remaining run trace budget', () => {
  const large = workflowStepInputPreview({ type: 'connection', args: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`field-${index}`, 'x'.repeat(300)])) });
  expect(large).toMatchObject({ mode: 'template', omitted: true, reason: 'step_limit' });
  expect(workflowStepInputPreview({ type: 'post', text: 'small' }, 1)).toMatchObject({ omitted: true, reason: 'run_limit' });
  expect(workflowStepInputPreview({ type: 'post', text: 'x'.repeat(5000) }).input.text).toHaveLength(320);
  const entries = Array.from({ length: 20 }, () => ({ inputPreview: workflowStepInputPreview({ type: 'post', text: 'x'.repeat(200) }) }));
  expect(workflowPreviewBytes(entries)).toBeGreaterThan(0);
  expect(MAX_RUN_PREVIEW_BYTES).toBe(8000);
  expect(publicWorkflowInputPreview({ mode: 'template', input: { password: 'leak', row: { ssn: 'leak' } } })).toMatchObject({
    input: { password: '[REDACTED]', row: '[OMITTED: runtime data]' },
  });
});
