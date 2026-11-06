const SHA=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const ALLOWED_TYPES=new Set(['text/css','text/javascript','application/json','text/plain','image/svg+xml','image/png','image/jpeg','image/gif','image/webp','image/avif','image/x-icon','font/woff','font/woff2','font/ttf','font/otf']);
const READ_CHUNK_BYTES=64*1024;

function decodePathSegment(value){
  let decoded;try{decoded=decodeURIComponent(value);}catch{return null;}
  if(!decoded||decoded==='.'||decoded==='..'||decoded.includes('/')||decoded.includes('\\\\')||decoded.includes('\\0')||!/^[A-Za-z0-9_.@+-]{1,100}$/.test(decoded))return null;
  return decoded;
}
function readBytes(value) {
  if(value instanceof Uint8Array)return value;
  if(value instanceof ArrayBuffer)return new Uint8Array(value);
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  return null;
}
async function hash(bytes){
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export async function servePublishedCommitAsset(request,env,url){
  const notFound=()=>new Response('Not found.',{status:404,headers:{'cache-control':'no-store','content-type':'text/plain; charset=utf-8'}});
  if(request.method!=='GET')return new Response('Method not allowed.',{status:405,headers:{allow:'GET','cache-control':'no-store'}});
  const raw=url.pathname.split('/').slice(2);
  if(raw.length<4)return notFound();
  const appId=decodePathSegment(raw[0]),commitSha=raw[1].toLowerCase(),assetToken=decodePathSegment(raw[2]);
  const pathParts=raw.slice(3).map(decodePathSegment);
  if(!appId||!assetToken||!SHA.test(commitSha)||pathParts.some(part=>!part))return notFound();
  const path=pathParts.join('/');
  if(path.length>240||pathParts.length>12)return notFound();
  const row=await env.DB.prepare(`SELECT f.content_type AS contentType,f.content_hash AS contentHash,f.size
    FROM hx_app_git_assets f
    JOIN hx_apps a ON a.org_id=f.org_id AND a.id=f.app_id
    JOIN hx_app_domains d ON d.org_id=a.org_id AND d.app_id=a.id AND d.status='active'
    JOIN hx_app_domain_public_consents consent ON consent.org_id=d.org_id AND consent.app_id=d.app_id
      AND consent.hostname=d.hostname AND consent.domain_created_at=d.created_at AND consent.confirmation_version=1
    WHERE a.id=?1 AND f.commit_sha=?2 AND f.path=?3
      AND f.app_version=CAST(json_extract(a.definition,'$.custom.publishedCommit.appVersion') AS INTEGER)
      AND json_extract(a.definition,'$.custom.publishedCommit.sha')=?2
      AND json_extract(a.definition,'$.custom.publishedCommit.assetToken')=?4`).bind(appId,commitSha,path,assetToken).first();
  if(!row||!ALLOWED_TYPES.has(row.contentType)||!Number.isSafeInteger(Number(row.size))||Number(row.size)<0||Number(row.size)>1_500_000)return notFound();

  // Read bounded BLOB slices instead of returning the entire D1 row. A
  // maximum-sized asset can exceed a D1 result's safe response envelope even
  // though it fits the app bundle limit; chunking keeps each query bounded.
  const size=Number(row.size),bytes=new Uint8Array(size);
  for(let offset=0;offset<size;offset+=READ_CHUNK_BYTES){
    const length=Math.min(READ_CHUNK_BYTES,size-offset);
    const part=await env.DB.prepare(`SELECT substr(content_bytes,?4,?5) AS contentBytes FROM hx_app_git_assets
      WHERE org_id=(SELECT org_id FROM hx_apps WHERE id=?1) AND app_id=?1 AND commit_sha=?2 AND path=?3
        AND app_version=CAST((SELECT json_extract(definition,'$.custom.publishedCommit.appVersion') FROM hx_apps WHERE id=?1) AS INTEGER)`)
      .bind(appId,commitSha,path,offset+1,length).first();
    const chunk=readBytes(part?.contentBytes);
    if(!chunk||chunk.length!==length)return notFound();
    bytes.set(chunk,offset);
  }
  if(await hash(bytes)!==row.contentHash)return notFound();
  return new Response(bytes,{headers:{
    'content-type':row.contentType,
    'content-security-policy':"default-src 'none'; sandbox",
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
    'access-control-allow-origin':'*',
    'cross-origin-resource-policy':'cross-origin',
    'referrer-policy':'no-referrer',
  }});
}
