import { expect, test } from 'vitest';
import { customRunner } from '../src/harness/customRunner.js';

test('sandbox custom app exposes a bounded annotation target bridge without opening network access', async () => {
  const response = customRunner();
  const html = await response.text();
  const policy = response.headers.get('content-security-policy');
  expect(policy).toContain(`connect-src 'none'`);
  expect(policy).toContain(`frame-src 'none'`);
  expect(html).toContain('document.elementsFromPoint(e.data.x,e.data.y)');
  expect(html).toContain('e.source!==parent');
  expect(html).toContain(`e.source===parent&&e.data?.type==='honmaru:annotation-target-request'`);
  expect(html).toContain(`e.source===child.contentWindow&&e.data?.type==='honmaru:annotation-target-result'`);
  expect(html).toContain(`target:typeof e.data.target==='string'?e.data.target.slice(0,100):''`);
});
