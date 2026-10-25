import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {copyServiceRuntime} from '../install-runtime.mjs';

test('installed runtime resolves ordinary and optional document dependencies outside the checkout',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'honmaru-installed-runtime-'));
 try {
  await copyServiceRuntime(fileURLToPath(new URL('../',import.meta.url)),directory);
  const client=await import(pathToFileURL(join(directory,'client.mjs')));
  let claims=0;
  await client.serve(async()=>{claims++;return {job:null}}, {once:true});
  assert.equal(claims,1);
  // Reaching config validation proves service module linking completed. No token,
  // network, launchd or container is touched by this negative startup fixture.
  const config=join(directory,'invalid-config.json');await writeFile(config,'{}');
  let failure;
  try {execFileSync(process.execPath,[join(directory,'service.mjs'),config],{stdio:'pipe'})}catch(e){failure=e}
  assert.ok(failure);
  assert.match(failure.stderr.toString(),/ERR_INVALID_ARG_TYPE/);
  assert.doesNotMatch(failure.stderr.toString(),/ERR_MODULE_NOT_FOUND/);
 } finally {await rm(directory,{recursive:true,force:true})}
});
