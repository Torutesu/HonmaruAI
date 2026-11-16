import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {browserContainerArgs,browserSessionIdentity,runBrowserSessionAction,validateBrowserAction} from '../browser-session.mjs';

test('browser state is isolated by workspace and stable Agent identity',()=>{
 const first=browserSessionIdentity('org-a','agent-a');
 assert.deepEqual(first,browserSessionIdentity('org-a','agent-a'));
 assert.notEqual(first.key,browserSessionIdentity('org-a','agent-b').key);
 assert.notEqual(first.key,browserSessionIdentity('org-b','agent-a').key);
 assert.match(first.containerName,/^honmaru-browser-[a-f0-9]{32}$/);
 assert.throws(()=>browserSessionIdentity('../org','agent-a'),/identity/);
});

test('browser VM has one private per-Agent volume, firewall capability and no published ports',()=>{
 const args=browserContainerArgs({name:'honmaru-browser-0123456789abcdef0123456789abcdef',image:'honmaru-browser:1650',volumeName:'honmaru-browser-0123456789abcdef0123456789abcdef',uid:501,gid:20});
 assert.ok(args.includes('--network')&&args[args.indexOf('--network')+1]==='default');
 assert.ok(args.includes('--cap-drop')&&args[args.indexOf('--cap-drop')+1]==='ALL');
 const caps=args.flatMap((arg,index)=>arg==='--cap-add'?[args[index+1]]:[]);
 assert.deepEqual(caps,['NET_ADMIN','SETUID','SETGID','CHOWN']);
 assert.ok(args.some(value=>value==='type=volume,source=honmaru-browser-0123456789abcdef0123456789abcdef,target=/data'));
 assert.ok(args.includes('--read-only'));
 assert.ok(!args.includes('--publish')&&!args.includes('-p'));
 assert.equal(args.filter(value=>value.startsWith('type=bind,')).length,0);
 assert.throws(()=>browserContainerArgs({name:'bad',image:'honmaru-browser:1650',volumeName:'bad',uid:501,gid:20}),/configuration/);
});

test('the per-Agent VM and durable volume are created once and reused for later actions',async()=>{
 const calls=[],volumes=new Set(),containers=new Map();
 const spawnProcess=(binary,args)=>{
  calls.push({binary,args});
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>true;
  process.nextTick(()=>{
   let output='';
   if(args[0]==='volume'&&args[1]==='list')output=JSON.stringify([...volumes].map(id=>({id})));
   else if(args[0]==='volume'&&args[1]==='create'){volumes.add(args.at(-1));output=args.at(-1);}
   else if(args[0]==='ls')output=JSON.stringify([...containers].map(([id,state])=>({id,status:{state}})));
   else if(args[0]==='run'){const name=args[args.indexOf('--name')+1];containers.set(name,'running');output=name;}
   else if(args[0]==='start')containers.set(args[1],'running');
   else if(args[0]==='exec')output=JSON.stringify({url:'https://example.com',title:'Example',status:200});
   child.stdout.end(output);child.stderr.end();child.emit('close',0);
  });
  return child;
 };
 const options={binary:'/container',image:'honmaru-browser:1650',workspaceId:'org-a',agentId:'agent-a',uid:501,gid:20,spawnProcess};
 const first=await runBrowserSessionAction({...options,action:{type:'navigate',url:'https://example.com'}});
 const second=await runBrowserSessionAction({...options,action:{type:'screenshot'}});
 assert.deepEqual(first,{url:'https://example.com',title:'Example',status:200});
 assert.deepEqual(second,first);
 assert.equal([...volumes].length,1);
 assert.equal(calls.filter(call=>call.args[0]==='run').length,1);
 const readinessExec=calls.find(call=>call.args[0]==='exec'&&call.args.some(value=>typeof value==='string'&&value.includes('37654')));
 const firstExec=calls.find(call=>call.args[0]==='exec'&&call.args.includes('/opt/honmaru/browser-command.mjs'));
 assert.deepEqual(calls[0].args.slice(0,3),['image','inspect','honmaru-browser:1650']);
 assert.ok(readinessExec&&firstExec&&calls.indexOf(readinessExec)<calls.indexOf(firstExec));
 assert.equal(firstExec.args.includes('--interactive'),true);
 const other=await runBrowserSessionAction({...options,agentId:'agent-b',action:{type:'screenshot'}});
 assert.deepEqual(other,first);
 assert.equal([...volumes].length,2);
 assert.equal(calls.filter(call=>call.args[0]==='run').length,2);
});

test('browser runtime builds its pinned local image on first use when missing',async()=>{
 const calls=[];let imageMissing=true;
 const spawnProcess=(binary,args)=>{
  calls.push(args);
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
  process.nextTick(()=>{
   let output='',code=0;
   if(args[0]==='image'&&args[1]==='inspect'&&imageMissing){imageMissing=false;code=1;}
   else if(args[0]==='build')output='honmaru-browser:1650';
   else if(args[0]==='volume'&&args[1]==='list')output='[]';
   else if(args[0]==='volume'&&args[1]==='create')output=args.at(-1);
   else if(args[0]==='ls')output='[]';
   else if(args[0]==='run')output=args[args.indexOf('--name')+1];
   else if(args[0]==='exec')output=JSON.stringify({url:'https://example.com',title:'Example'});
   child.stdout.end(output);child.stderr.end();child.emit('close',code);
  });
  return child;
 };
 const result=await runBrowserSessionAction({binary:'/container',workspaceId:'org-build',agentId:'agent-build',uid:501,gid:20,spawnProcess,action:{type:'navigate',url:'https://example.com'}});
 assert.equal(result.title,'Example');
 const build=calls.find(args=>args[0]==='build');
 assert.ok(build);
 assert.equal(build[build.indexOf('--tag')+1],'honmaru-browser:1650');
 assert.ok(build.some(value=>value.endsWith('/gateway/browser-image/Dockerfile')));
});

test('browser action protocol accepts bounded human-like actions and rejects code execution',()=>{
 assert.deepEqual(validateBrowserAction({type:'navigate',url:'https://example.com/path'}),{type:'navigate',url:'https://example.com/path'});
 assert.deepEqual(validateBrowserAction({type:'click',x:32,y:44}),{type:'click',x:32,y:44});
 assert.deepEqual(validateBrowserAction({type:'press',key:'Enter'}),{type:'press',key:'Enter'});
 for(const action of [
  {type:'navigate',url:'file:///etc/passwd'},
  {type:'navigate',url:'javascript:alert(1)'},
  {type:'navigate',url:'https://user:pass@example.com'},
  {type:'click',x:-1,y:0},
  {type:'type',text:'x'.repeat(2001)},
  {type:'press',key:'F12'},
  {type:'scroll',x:0,y:0,deltaX:0,deltaY:2001},
  {type:'evaluate',code:'fetch(\\"https://example.com\\")'},
 ]) assert.throws(()=>validateBrowserAction(action));
});

test('browser volume ownership avoids traversing private Chromium profile files',async()=>{
 const script=await readFile(new URL('../browser-image/browser-entrypoint.sh',import.meta.url),'utf8');
 assert.match(script,/chown "\$BROWSER_UID:\$BROWSER_GID" \/data/);
 assert.doesNotMatch(script,/find \/data .*chown -R/);
 const create=script.indexOf('> /run/honmaru/control-token');
 const mode=script.indexOf('chmod 0400 /run/honmaru/control-token');
 const owner=script.indexOf('chown "$BROWSER_UID:$BROWSER_GID" /run/honmaru/control-token');
 assert.ok(create>=0&&mode>create&&owner>mode);
});
