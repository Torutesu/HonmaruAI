// Keep the machine-readable inventory and the human review table consistent.
// This checks bookkeeping only, never feature completeness or Kylon parity.
import { readFileSync } from 'node:fs';

const root = new URL('../docs/kylon-parity/', import.meta.url);
const inventory = JSON.parse(readFileSync(new URL('requirements.json', root), 'utf8'));
const { requirements } = inventory;
const matrix = readFileSync(new URL('matrix.md', root), 'utf8');
const rows = new Map();
for (const line of matrix.split('\n')) {
  if (!line.startsWith('| KY-')) continue;
  const cells = line.split('|').slice(1, -1).map(s => s.trim());
  if (rows.has(cells[0])) throw new Error(`Duplicate matrix row: ${cells[0]}`);
  rows.set(cells[0], cells[2]);
}
const asOf = matrix.match(/^調査基準日: (\d{4}-\d{2}-\d{2})/m)?.[1];
if (asOf !== inventory.asOf) {
  throw new Error(`Matrix date=${asOf}, requirements.asOf=${inventory.asOf}`);
}
const matrixCount = Number(matrix.match(/^全(\d+)項目。/m)?.[1]);
if (matrixCount !== requirements.length) throw new Error(`Matrix total=${matrixCount}, requirements=${requirements.length}`);
const seen = new Set();
const counts = {};
for (const item of requirements) {
  if (seen.has(item.id)) throw new Error(`Duplicate requirement: ${item.id}`);
  seen.add(item.id);
  const label = rows.get(item.id);
  const status = label?.startsWith('一部') ? 'partial'
    : label === '未実装' ? 'missing'
    : label === '実装あり' ? 'implemented'
    : label === '要検証' ? 'unverified' : undefined;
  if (status !== item.status) throw new Error(`${item.id}: JSON=${item.status}, matrix=${label}`);
  counts[status] = (counts[status] || 0) + 1;
}
for (const id of rows.keys()) {
  if (!seen.has(id)) throw new Error(`Missing JSON requirement: ${id}`);
}
console.log(JSON.stringify({ requirements: seen.size, counts, note: 'Inventory consistency only; not a completion percentage.' }, null, 2));
