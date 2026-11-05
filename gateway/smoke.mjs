undefined
const files = await runIsolated({
  code: "const fs = await import('node:fs/promises'); return await fs.readFile('src/input.txt','utf8');",
  files: [{ path: 'src/input.txt', base64: Buffer.from('ephemeral input').toString('base64') }],
});
assert.equal(files.status, 'succeeded', files.stderr);
assert.equal(files.stdout, JSON.stringify('ephemeral input'));
console.log('Virtual files passed: mounted only in the per-run tmpfs workspace.');
