const assert = require('node:assert/strict');
const test = require('node:test');
const {affectsIos} = require('./ios-impact.cjs');

test('documentation and Worker changes do not reserve an iOS simulator', () => {
  assert.equal(affectsIos([
    'docs/kylon-parity/matrix.md',
    'worker/src/harness/workflows.js',
    '.github/workflows/ci.yml',
  ]), false);
});

test('native project, shared mobile code, app versions and root dependencies run the simulator suite', () => {
  for (const path of [
    'TikTokForWork/Views/RoomView.swift',
    'TikTokForWork.xcodeproj/project.pbxproj',
    'apps/mobile/src/App.tsx',
    'packages/core/src/protocol.ts',
    'packages/protocol/src/events.ts',
    'VERSION',
    'package.json',
    'package-lock.json',
    'scripts/check-versions.mjs',
    'project.yml',
  ]) assert.equal(affectsIos([path]), true, path);
});

test('empty and unrelated paths fail closed to a skipped native suite', () => {
  assert.equal(affectsIos([]), false);
  assert.equal(affectsIos(['web-react/src/App.tsx', 'worker/schema.sql', 'README.md']), false);
});
