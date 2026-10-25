import {createHash} from 'node:crypto';
import {readFileVersionContent} from './fileVersionLedger.js';

// Internal, not routed. No persistent signed URL: every download must pass the
// current room/workspace policy, including after the object storage read.
export async function downloadFileVersion(env,identity) {
 const source=await readFileVersionContent(env.DB,identity);
 if(!source)return null;
 const object=await env.MEDIA.get(source.objectKey);
 if(!object)return null;
 if(object.size!==source.size||source.size>25*1024*1024){await object.body.cancel().catch(()=>{});throw Error('Stored file size differs.');}
 const bytes=await object.arrayBuffer();
 if(bytes.byteLength!==source.size||createHash('sha256').update(new Uint8Array(bytes)).digest('hex')!==source.contentHash)throw Error('Stored file content differs.');
 const current=await readFileVersionContent(env.DB,identity);
 if(!current||current.objectKey!==source.objectKey||current.contentHash!==source.contentHash)return null;
 return new Response(bytes,{headers:{
  'content-type':source.contentType,
  'content-length':String(source.size),
  'content-disposition':`attachment; filename="file-v${source.version}"`,
  'cache-control':'private, no-store',
  'x-content-type-options':'nosniff',
  'content-security-policy':"default-src 'none'; sandbox",
 }});
}
