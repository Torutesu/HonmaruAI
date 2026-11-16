import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const BROWSER_NAME = /^honmaru-browser-[a-f0-9]{32}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const imageBuilds=new Map();
const BROWSER_READY_PROBE = [
 "const net = require('node:net');",
 "const deadline = Date.now() + 20_000;",
 "function probe() {",
 "  const socket = net.createConnection({ host: '127.0.0.1', port: 37654 });",
 "  socket.once('connect', () => { socket.destroy(); process.exit(0); });",
 "  socket.once('error', () => { socket.destroy(); if (Date.now() >= deadline) process.exit(1); setTimeout(probe, 100); });",
 "}",
 "probe();",
].join('\\n');

function agentDigest(workspaceId, agentId) {
  if (!SAFE_ID.test(String(workspaceId || '')) || !SAFE_ID.test(String(agentId || ''))) {
    throw new Error('Invalid browser session identity.');
  }
  return createHash('sha256').update(`${workspaceId}\0${agentId}`).digest('hex');
}

export function browserSessionIdentity(workspaceId, agentId) {
  const digest = agentDigest(workspaceId, agentId);
  const name=`honmaru-browser-${digest.slice(0, 32)}`;
  return {key:digest,containerName:name,volumeName:name};
}

export function browserContainerArgs({name, image, volumeName, uid, gid}) {
  if (!BROWSER_NAME.test(name || '') || !/^honmaru-browser:[0-9]+$/.test(image || '')) throw new Error('Invalid browser container configuration.');
  if(!BROWSER_NAME.test(volumeName||''))throw new Error('Invalid browser profile volume.');
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) throw new Error('Invalid browser account.');
  return [
    'run','--rm','--detach','--name',name,'--network','default',
    '--read-only','--tmpfs','/tmp:size=256M,mode=1777','--tmpfs','/run:size=8M,mode=755',
    '--mount',`type=volume,source=${volumeName},target=/data`,
    '--cap-drop','ALL','--cap-add','NET_ADMIN','--cap-add','SETUID','--cap-add','SETGID','--cap-add','CHOWN','--cpus','2','--memory','2g','--shm-size','512m',
    '-e',`BROWSER_UID=${uid}`,'-e',`BROWSER_GID=${gid}`,'-i',image,
  ];
}

export function validateBrowserAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser action.');
  switch (value.type) {
    case 'navigate': {
      if (typeof value.url !== 'string' || value.url.length > 2048) throw new Error('Invalid browser URL.');
      let url;
      try { url = new URL(value.url); } catch { throw new Error('Invalid browser URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid browser URL.');
      return {type:'navigate',url:url.href};
    }
    case 'click':
      if (![value.x, value.y].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 4096)) throw new Error('Invalid browser coordinates.');
      return {type:'click',x:value.x,y:value.y};
    case 'type':
      if (typeof value.text !== 'string' || value.text.length > 2000) throw new Error('Invalid browser text input.');
      return {type:'type',text:value.text};
    case 'press':
      if (!['Enter','Escape','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Backspace','Delete','Home','End','PageUp','PageDown'].includes(value.key)) throw new Error('Invalid browser key.');
      return {type:'press',key:value.key};
    case 'scroll':
      if (![value.x,value.y,value.deltaX,value.deltaY].every(Number.isSafeInteger) || value.x < 0 || value.y < 0 || value.x > 4096 || value.y > 4096 || Math.abs(value.deltaX) > 2000 || Math.abs(value.deltaY) > 2000) throw new Error('Invalid browser scroll.');
      return {type:'scroll',x:value.x,y:value.y,deltaX:value.deltaX,deltaY:value.deltaY};
    case 'screenshot': return {type:'screenshot'};
    case 'visible_text': return {type:'visible_text'};
    default: throw new Error('Unsupported browser action.');
  }
}

function runCli(binary, args, {input, timeoutMs=30000, spawnProcess=spawn,signal}={}) {
  return new Promise((resolvePromise,reject)=>{
    const child=spawnProcess(binary,args,{stdio:['pipe','pipe','pipe'],shell:false,signal});
    const stdout=[],stderr=[];let outBytes=0,errBytes=0,settled=false,timer;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolvePromise(result);};
    child.stdout.on('data',chunk=>{outBytes+=chunk.length;if(outBytes>4*1024*1024){child.kill('SIGKILL');finish(new Error('Browser response is too large.'));return;}stdout.push(chunk);});
    child.stderr.on('data',chunk=>{errBytes+=chunk.length;if(errBytes<=8192)stderr.push(chunk.subarray(0,8192));});
    child.once('error',()=>finish(new Error('The local browser runtime is unavailable.')));
    child.once('close',code=>{
      if(code!==0){
        const message=Buffer.concat(stderr).toString('utf8').trim().slice(-1200);
        finish(new Error(message||'The local browser runtime failed.'));
      } else finish(null,Buffer.concat(stdout));
    });
    timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('Browser command timed out.'));},timeoutMs);
    if(input!==undefined)child.stdin.end(input);else child.stdin.end();
  });
}

async function containerExists(binary,name,spawnProcess,signal) {
  try {
    const output=await runCli(binary,['ls','--all','--format','json'],{timeoutMs:10000,spawnProcess,signal});
    const rows=JSON.parse(output.toString('utf8'));
    return Array.isArray(rows)?rows.find(row=>row.id===name)||null:null;
  } catch {
    if(signal?.aborted)throw new Error('Browser action cancelled.');
    return null;
  }
}

async function ensureBrowserVolume(binary,volumeName,spawnProcess,signal) {
  if(!BROWSER_NAME.test(volumeName||''))throw new Error('Invalid browser profile volume.');
  const output=await runCli(binary,['volume','list','--format','json'],{timeoutMs:10000,spawnProcess,signal});
  let volumes;
  try { volumes=JSON.parse(output.toString('utf8')); }
  catch { throw new Error('The local browser volume list is invalid.'); }
  if(!Array.isArray(volumes))throw new Error('The local browser volume list is invalid.');
  if(volumes.some(volume=>volume.id===volumeName))return;
  await runCli(binary,['volume','create','--opt','size=10g',volumeName],{timeoutMs:30000,spawnProcess,signal});
}

async function ensureBrowserImage(binary,image,spawnProcess,signal) {
  try { await runCli(binary,['image','inspect',image],{timeoutMs:10000,spawnProcess,signal}); return; }
  catch { if(signal?.aborted)throw new Error('Browser action cancelled.'); }
  const key=`${binary}\0${image}`;
  if(!imageBuilds.has(key)){
    const root=dirname(fileURLToPath(import.meta.url));
    const build=runCli(binary,['build','--tag',image,'-f',join(root,'browser-image','Dockerfile'),root],{timeoutMs:240000,spawnProcess,signal})
      .then(()=>true).finally(()=>imageBuilds.delete(key));
    imageBuilds.set(key,build);
  }
  await imageBuilds.get(key);
}

async function waitForBrowserCommand(binary,containerName,uid,spawnProcess,signal) {
  if(signal?.aborted)throw new Error('Browser action cancelled.');
  try {
    await runCli(binary,['exec','--uid',String(uid),containerName,'node','-e',BROWSER_READY_PROBE],{
      timeoutMs:25_000,spawnProcess,signal,
    });
  } catch {
    if(signal?.aborted)throw new Error('Browser action cancelled.');
    throw new Error('The local browser session did not become ready.');
  }
}

export async function runBrowserSessionAction({
  binary=process.env.HONMARU_CONTAINER_BIN||'container',image='honmaru-browser:1650',
  workspaceId,agentId,action,uid=process.getuid(),gid=process.getgid(),spawnProcess=spawn,signal,
}={}) {
  const cleanAction=validateBrowserAction(action);
  if(signal?.aborted)throw new Error('Browser action cancelled.');
  const session=browserSessionIdentity(workspaceId,agentId);
  await ensureBrowserImage(binary,image,spawnProcess,signal);
  await ensureBrowserVolume(binary,session.volumeName,spawnProcess,signal);
  const existing=await containerExists(binary,session.containerName,spawnProcess,signal);
  if(existing?.status?.state==='stopped'){
    await runCli(binary,['start',session.containerName],{timeoutMs:30000,spawnProcess,signal});
  } else if(existing?.status?.state!=='running'){
    const args=browserContainerArgs({name:session.containerName,image,volumeName:session.volumeName,uid,gid});
    await runCli(binary,args,{timeoutMs:180000,spawnProcess,signal});
  }
  await waitForBrowserCommand(binary,session.containerName,uid,spawnProcess,signal);\n  const output=await runCli(binary,['exec','--interactive','--uid',String(uid),session.containerName,'node','/opt/honmaru/browser-command.mjs'],{
    input:JSON.stringify(cleanAction),timeoutMs:30000,spawnProcess,signal,
  });
  try { return JSON.parse(output.toString('utf8')); }
  catch { throw new Error('The browser returned an invalid response.'); }
}
