import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const execute=promisify(execFile);
export const DOCUMENT_INPUT_LIMIT=2*1024*1024;
export const DOCUMENT_OUTPUT_LIMIT=25*1024*1024;

// Trusted guest-side converter; production callers must run this in the
// no-network document VM, not on the host or in the ordinary JS runner.
export async function convertDocument({text,inputFormat,format},{run=execute,pandoc='pandoc',soffice='soffice',signal,timeoutMs=120000}={}){
 if(typeof text!=='string'||Buffer.byteLength(text)>DOCUMENT_INPUT_LIMIT||!['markdown','html'].includes(inputFormat)||!['pdf','docx'].includes(format))throw Error('Invalid document conversion input.');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw Error('Invalid document conversion deadline.');
 signal?.throwIfAborted();
 const directory=await mkdtemp(join(tmpdir(),'honmaru-document-'));
 const deadline=Date.now()+timeoutMs;
 const invoke=async(binary,args)=>{
  signal?.throwIfAborted();const remaining=deadline-Date.now();
  if(remaining<=0)throw Error('Document conversion timed out.');
  await run(binary,args,{cwd:directory,timeout:remaining,signal,maxBuffer:32768,env:{...process.env,HOME:directory,TMPDIR:directory}});
 };
 try{
  const source=join(directory,`source.${inputFormat==='markdown'?'md':'html'}`);
  await writeFile(source,text,{mode:0o600});
  const docx=join(directory,'source.docx');
  // HTML output avoids Pandoc's external DOCX assets, which sandbox mode cannot read.
  const html=join(directory,'source.html');
  if(inputFormat==='markdown')await invoke(pandoc,['--sandbox','--from=gfm','--to=html5','--output',html,source]);
  await invoke(soffice,[`-env:UserInstallation=${pathToFileURL(join(directory,'profile')).href}`,'--headless','--convert-to','docx:Office Open XML Text','--outdir',directory,html]);
  if(format==='pdf')await invoke(soffice,[`-env:UserInstallation=${pathToFileURL(join(directory,'profile')).href}`,'--headless','--convert-to','pdf:writer_pdf_Export','--outdir',directory,docx]);
  signal?.throwIfAborted();
  const output=join(directory,`source.${format}`),info=await stat(output);
  if(!info.isFile()||info.size===0||info.size>DOCUMENT_OUTPUT_LIMIT)throw Error('Invalid document output size.');
  const bytes=await readFile(output);
  if(format==='pdf'?!bytes.subarray(0,5).equals(Buffer.from('%PDF-')):!bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04])))throw Error('Document converter returned an invalid format.');
  return {bytes,format,contentType:format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 }finally{await rm(directory,{recursive:true,force:true});}
}
