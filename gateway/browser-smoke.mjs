// Synthetic-only smoke for the Mac mini's per-Agent isolated browser.
// It uses a fresh Workspace/Agent identity and deletes only those profiles.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {browserSessionIdentity, runBrowserSessionAction} from './browser-session.mjs';

const gatewayConfigPath=join(homedir(),'.local/share/honmaru/gateway/service.json');
let serviceConfig={};
try{serviceConfig=JSON.parse(await readFile(gatewayConfigPath,'utf8'));}catch{}
const binary=process.env.HONMARU_CONTAINER_BIN||serviceConfig.containerBinary||'container';
const pageUrl=process.env.HONMARU_BROWSER_SMOKE_URL||'https://example.com/';
const suffix=randomUUID();
const workspaceId=`honmaru-browser-smoke-${suffix}`;
const agentIds=[`smoke-a-${suffix}`,`smoke-b-${suffix}`];
const sessions=agentIds.map(agentId=>browserSessionIdentity(workspaceId,agentId));
const act=(agentId,action)=>runBrowserSessionAction({binary,workspaceId,agentId,action});
const screenshotPath=join(tmpdir(),`honmaru-browser-smoke-${suffix}.jpg`);
let phase='startup';

function cleanup(){
  for(const session of sessions){
    try{execFileSync(binary,['stop','--time','5',session.containerName],{stdio:'ignore'});}catch{}
    try{execFileSync(binary,['volume','rm',session.volumeName],{stdio:'ignore'});}catch{}
  }
}

try{
  phase='navigate';
  const opened=await act(agentIds[0],{type:'navigate',url:pageUrl});
  assert.equal(opened.status,200,`Expected HTTP 200 from ${new URL(pageUrl).origin}.`);
  phase='read-visible-text';
  const page=await act(agentIds[0],{type:'visible_text'});
  assert.equal(page.url,new URL(pageUrl).href);
  assert.ok(page.title,'The browser page should expose a title.');
  phase='capture-screenshot';
  const screenshot=await act(agentIds[0],{type:'screenshot'});
  const bytes=Buffer.from(screenshot.image,'base64');
  assert.ok(bytes.length>1000&&bytes.length<=2*1024*1024,'The JPEG must be non-empty and bounded.');
  await writeFile(screenshotPath,bytes,{flag:'wx',mode:0o600});

  // A second Agent in the same Workspace must receive its own clean profile.
  phase='verify-agent-isolation';
  const isolated=await act(agentIds[1],{type:'visible_text'});
  assert.equal(isolated.url,'about:blank');
  assert.notEqual(sessions[0].volumeName,sessions[1].volumeName);
  console.log(JSON.stringify({ok:true,url:opened.url,status:opened.status,title:opened.title,
    visibleTextBytes:Buffer.byteLength(page.text),screenshotBytes:bytes.length,
    screenshotPath,secondAgentStartsBlank:true}));
}catch(error){
  console.error(JSON.stringify({ok:false,phase,error:String(error?.message||error).split('\n')[0]}));
  throw error;
}finally{cleanup();}
