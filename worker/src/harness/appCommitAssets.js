const SHA=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const ALLOWED_TYPES=new Set(['text/css','text/javascript','application/json','text/plain','image/svg+xml','image/png','image/jpeg','image/gif','image/webp','image/avif','image/x-icon','font/woff','font/woff2','font/ttf','font/otf']);

function decodePathSegment(value){
  let decoded;try{decoded=decodeURIComponent(value);}catch{return null;}
  if(!decoded||decoded==='.'||decoded==='..'||decoded.includes('/')||decoded.includes('\\')||decoded.includes('\0')||!/^[A-Za-z0-9_.@+-]{1,100}$/.test(decoded))return null;
  return decoded;
}
function decodeBase64(value){
  try{
    const normalized=String(value||'').replace(/\s/g,'');
    if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized))return null;
    const binary=atob(normalized),bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    return bytes;
  }catch{return null;}
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
  const row=await env.DB.prepare(`SELECT f.content_type AS contentType,f.content_bytes AS contentBytes,f.content_hash AS contentHash,f.size
    FROM hx_app_git_assets f
    JOIN hx_apps a ON a.org_id=f.org_id AND a.id=f.app_id
    JOIN hx_app_domains d ON d.org_id=a.org_id AND d.app_id=a.id AND d.status='active'
    WHERE a.id=?1 AND f.commit_sha=?2 AND f.path=?3
      AND f.app_version=CAST(json_extract(a.definition,'$.custom.publishedCommit.appVersion') AS INTEGER)
      AND json_extract(a.definition,'$.custom.publishedCommit.sha')=?2
      AND json_extract(a.definition,'$.custom.publishedCommit.assetToken')=?4`).bind(appId,commitSha,path,assetToken).first();
  if(!row||!ALLOWED_TYPES.has(row.contentType)||row.size<0||row.size>1_500_000)return notFound();
  const bytes=readBytes(row.contentBytes);
  if(!bytes||bytes.length!==Number(row.size)||await hash(bytes)!==row.contentHash)return notFound();
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
