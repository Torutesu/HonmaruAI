const SHA=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const ALLOWED_TYPES=new Set(['text/css','text/javascript','application/json','text/plain','image/svg+xml','image/png','image/jpeg','image/gif','image/webp','image/avif','image/x-icon','font/woff','font/woff2','font/ttf','font/otf']);

function decodePathSegment(value){
  let decoded;try{decoded=decodeURIComponent(value);}catch{return null;}
  if(!decoded||decoded==='.'||decoded==='..'||decoded.includes('/')||decoded.includes('\\')||decoded.includes('\0')||!/^[A-Za-z0-9_.@+-]{1,100}$/.test(decoded))return null;
  return decoded;
}
function readHexBytes(value) {
  if (typeof value !== 'string' || value.length % 2 || !/^[a-f0-9]*$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
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
  const lookup=`SELECT f.content_type AS contentType,hex(substr(f.content_bytes,?5,?6)) AS contentHex,f.content_hash AS contentHash,f.size
    FROM hx_app_git_assets f
    JOIN hx_apps a ON a.org_id=f.org_id AND a.id=f.app_id
    JOIN hx_app_domains d ON d.org_id=a.org_id AND d.app_id=a.id AND d.status='active'
    JOIN hx_app_domain_public_consents consent ON consent.org_id=d.org_id AND consent.app_id=d.app_id
      AND consent.hostname=d.hostname AND consent.domain_created_at=d.created_at AND consent.confirmation_version=1
    WHERE a.id=?1 AND f.commit_sha=?2 AND f.path=?3
      AND f.app_version=CAST(json_extract(a.definition,'$.custom.publishedCommit.appVersion') AS INTEGER)
      AND json_extract(a.definition,'$.custom.publishedCommit.sha')=?2
      AND json_extract(a.definition,'$.custom.publishedCommit.assetToken')=?4`;
  const chunkSize=256_000;
  const row=await env.DB.prepare(lookup).bind(appId,commitSha,path,assetToken,1,chunkSize).first();
  if(!row||!ALLOWED_TYPES.has(row.contentType)||row.size<0||row.size>1_500_000)return notFound();
  const size=Number(row.size);
  const bytes=new Uint8Array(size);
  let offset=0;
  for(let start=1;start<=size;start+=chunkSize){
    const hex=start===1?row.contentHex:(await env.DB.prepare(lookup).bind(appId,commitSha,path,assetToken,start,chunkSize).first())?.contentHex;
    const chunk=readHexBytes(hex);
    if(!chunk||offset+chunk.length>size)return notFound();
    bytes.set(chunk,offset);offset+=chunk.length;
  }
  if(offset!==size||await hash(bytes)!==row.contentHash)return notFound();
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
