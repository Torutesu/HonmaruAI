// Every workflow and script that runs wrangler with the production token
// runs the exact version worker/package.json pins (#962), never "the newest
// 4.x today", so a release published between two deploys cannot run with
// the token before anyone has looked at it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const pinned = JSON.parse(fs.readFileSync(path.join(root, 'worker/package.json'), 'utf8')).devDependencies.wrangler;
const files = [
  ...fs.readdirSync(path.join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`),
  ...fs.readdirSync(path.join(root, 'worker/scripts')).filter((f) => /\.(mjs|sh|js)$/.test(f)).map((f) => `worker/scripts/${f}`),
];

test('wrangler is pinned to an exact version in package.json', () => {
  assert.match(pinned, /^\d+\.\d+\.\d+$/);
});

test('every workflow and script runs that exact wrangler', () => {
  const off = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of text.matchAll(/wrangler@([0-9][\w.-]*)/g)) if (m[1] !== pinned) off.push(`${file}: wrangler@${m[1]}`);
  }
  assert.deepStrictEqual(off, [], `use wrangler@${pinned}`);
});
