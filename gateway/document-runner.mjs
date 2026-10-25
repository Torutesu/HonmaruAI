import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {DOCUMENT_INPUT_LIMIT,DOCUMENT_OUTPUT_LIMIT} from './document-converter.mjs';
const execute=promisify(execFile);
const guest=`import {convertDocument} from '/opt/honmaru/document-converter.mjs';let raw='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>13000000)throw Error('Input too large');}const out=await convertDocument(JSON.parse(raw));process.stdout.write(out.bytes);`;

// Deliberately opt-in: callers must configure the verified document image digest.
// Binary artifacts bypass the ordinary execution result's 32 KiB text limit.
export async function runDocumentIsolated(payload,{image,binary=process.env.HONMARU_CONTAINER_BIN||'container',signal,timeoutMs=150000,run=execute}={}){
 if(typeof image!=='string'||!/^\S+@sha256:[a-f0-9]{64}$/.test(image))throw Error('A pinned document image is required.');
 if(!payload||typeof payload.text!=='string'||Buffer.byteLength(payload.text)>DOCUMENT_INPUT_LIMIT||!['markdown','html'].includes(payload.inputFormat)||!['pdf','docx'].includes(payload.format))throw Error('Invalid document conversion input.');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>150000)throw Error('Invalid document deadline.');
 signal?.throwIfAborted();
 await verifyDocumentImage(image,{binary,signal,run});
 const clean={text:payload.text,inputFormat:payload.inputFormat,format:payload.format};
 const name='honmaru-'+randomUUID();
 try{
  const pending=run(binary,['run','--rm','--name',name,'--network','none','--no-dns','--read-only','--tmpfs','/tmp','--cap-drop','ALL','--uid','65534','--gid','65534','--cpus','1','--memory','1g','--ulimit','nofile=256:256','--ulimit','nproc=128:128','--progress','none','-i',image,'node','--input-type=module','-e',guest],{encoding:'buffer',maxBuffer:DOCUMENT_OUTPUT_LIMIT,timeout:timeoutMs,signal});
  pending.child.stdin.on('error',()=>{});
  pending.child.stdin.end(JSON.stringify(clean));
  const {stdout}=await pending;
  signal?.throwIfAborted();
  const valid=Buffer.isBuffer(stdout)&&stdout.length>0&&stdout.length<=DOCUMENT_OUTPUT_LIMIT&&(clean.format==='pdf'?stdout.subarray(0,5).equals(Buffer.from('%PDF-')):stdout.subarray(0,4).equals(Buffer.from([80,75,3,4])));
  if(!valid)throw Error('Invalid document artifact.');
  return {bytes:stdout,format:clean.format,size:stdout.length,sha256:createHash('sha256').update(stdout).digest('hex'),contentType:clean.format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
 }finally{
  // Abort/timeout kills the CLI; explicitly stop the VM too. Cleanup must not
  // inherit the cancelled signal or leave user document data in a live VM.
  await run(binary,['kill','--signal','KILL',name],{timeout:5000}).catch(()=>{});
  await run(binary,['delete','--force',name],{timeout:5000}).catch(()=>{});
 }
}

export async function verifyDocumentImage(image,{binary=process.env.HONMARU_CONTAINER_BIN||'container',signal,run=execute}={}){
 if(typeof image!=='string'||!/^\S+@sha256:[a-f0-9]{64}$/.test(image))throw Error('A pinned document image is required.');
 const inspected=await run(binary,['image','inspect',image],{encoding:'utf8',maxBuffer:1024*1024,timeout:10000,signal});
 let installed;try{installed=JSON.parse(inspected.stdout);}catch{throw Error('Document image inspection failed.');}
 const digest=image.split('@sha256:')[1];
 if(!Array.isArray(installed)||installed.length!==1||installed[0].id!==digest)throw Error('Document image digest does not match.');
 signal?.throwIfAborted();
}
