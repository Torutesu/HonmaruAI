import {readFile} from 'node:fs/promises';
import {validateBrowserAction} from './browser-session.mjs';

let raw='';
for await (const chunk of process.stdin) {
  raw+=chunk;
  if(Buffer.byteLength(raw)>16*1024)throw new Error('Browser action is too large.');
}
const action=validateBrowserAction(JSON.parse(raw));
const token=(await readFile('/run/honmaru/control-token','utf8')).trim();
const response=await fetch('http://127.0.0.1:37654/command',{
  method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(action),signal:AbortSignal.timeout(25000),
});
if(!response.ok)throw new Error('Browser command failed.');
const result=await response.text();
if(Buffer.byteLength(result)>3*1024*1024)throw new Error('Browser response is too large.');
process.stdout.write(result);
