const API = 'https://api.github.com';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const REF_PART = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_HTML_BYTES = 119800;
const MAX_BUNDLE_BYTES = 1_500_000;
const MAX_ASSETS = 50;
const MAX_TREE_ENTRIES = 5000;
const MAX_JSON_BYTES = 2_100_000;

function safeRepoPart(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..';
}
function safeBranch(value) {
  return typeof value === 'string' && value.length <= 240 && value.split('/').length <= 8
    && value.split('/').every(part => REF_PART.test(part) && part !== '.' && part !== '..')
    && !value.startsWith('/') && !value.endsWith('/') && !value.includes('//');
}
function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  const parts=value.split('/');
  return parts.length<=12 && parts.every(part=>part && part!=='.' && part!=='..' && /^[A-Za-z0-9_.@+-]{1,100}$/.test(part));
}
function tokenValue(token) { return typeof token === 'string' && token && token !== 'email-auth' ? token : null; }
async function readBounded(response, limit) {
  const size=Number(response.headers.get('content-length')||0);
  if(size>limit){await response.body?.cancel();throw new Error('GitHub source response exceeds the size limit.');}
  const reader=response.body?.getReader();
  if(!reader) return new Uint8Array();
  const chunks=[];let total=0;
  for(;;){
    const {done,value}=await reader.read();if(done)break;
    total+=value.byteLength;
    if(total>limit){await reader.cancel();throw new Error('GitHub source response exceeds the size limit.');}
    chunks.push(value);
  }
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}
async function githubJson(token,path,limit=MAX_JSON_BYTES) {
  const response=await fetch(`${API}${path}`,{
    method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000),
    headers:{authorization:`Bearer ${token}`,accept:'application/vnd.github+json','user-agent':'HonmaruAI','x-github-api-version':'2022-11-28'},
  });
  if(response.status>=300&&response.status<400){await response.body?.cancel();throw new Error('GitHub redirected a source request.');}
  if(!response.ok){await response.body?.cancel();throw new Error(`GitHub source request failed (${response.status}).`);}
  const bytes=await readBounded(response,limit);
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{throw new Error('GitHub returned invalid source metadata.');}
}
async function currentBranchSha(token,owner,repo,branch){
  const segments=branch.split('/').map(encodeURIComponent).join('/');
  const ref=await githubJson(token,`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${segments}`,256_000);
  const sha=ref?.object?.sha;
  if(typeof sha!=='string'||!SHA.test(sha))throw new Error('GitHub did not return a valid branch commit.');
  return sha.toLowerCase();
}
async function sha256(bytes){
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function base64FromBytes(bytes){
  let binary='';
  for(let offset=0;offset<bytes.length;offset+=0x8000)
    binary+=String.fromCharCode(...bytes.subarray(offset,Math.min(offset+0x8000,bytes.length)));
  return btoa(binary);
}
function decodeBase64(value){
  if(typeof value!=='string')throw new Error('GitHub returned invalid source content.');
  const encoded=value.replace(/\s/g,'');
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new Error('GitHub returned invalid source content.');
  return Uint8Array.from(atob(encoded),char=>char.charCodeAt(0));
}
function mimeFor(path){
  const ext=path.split('.').pop().toLowerCase();
  return ({css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',txt:'text/plain',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',ico:'image/x-icon',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'}[ext])||null;
}
function resolveReference(from,target){
  const value=String(target||'').trim().replace(/^['"]|['"]$/g,'');
  if(!value||value.startsWith('#'))return {ignored:true};
  if(/^(?:data:|blob:)/i.test(value))return {ignored:true};
  if(/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|\\)/i.test(value)||value.includes('?')||value.includes('#'))throw new Error('External, absolute, and query-based assets are not supported. Add the asset to the Git commit.');
  let pathParts=from.split('/').slice(0,-1);
  for(const part of value.split('/')){
    if(!part||part==='.')continue;
    if(part==='..'){if(!pathParts.length)throw new Error('A GitHub asset path escapes the repository root.');pathParts.pop();continue;}
    pathParts.push(part);
  }
  const path=pathParts.join('/');
  if(!safePath(path))throw new Error('A GitHub asset path is invalid.');
  return {path};
}
function references(path,text){
  const out=[];
  const add=(target)=>out.push(target);
  if(path==='index.html'||/\.html?$/i.test(path)){
    for(const match of text.matchAll(/<(script|link|img|source|video|audio)\b[^>]*>/gi)){
      const tag=match[0],name=match[1].toLowerCase();
      if(name==='script'){const src=/\bsrc\s*=\s*(['"])(.*?)\1/i.exec(tag);if(src)add(src[2]);}
      else if(name==='link'){
        const rel=/\brel\s*=\s*(['"])(.*?)\1/i.exec(tag);
        if(rel&&/(?:stylesheet|icon|preload|modulepreload)/i.test(rel[2])){const href=/\bhref\s*=\s*(['"])(.*?)\1/i.exec(tag);if(href)add(href[2]);}
      }else{
        for(const attr of name==='video'?['src','poster']:['src']){const m=new RegExp('\\b'+attr+'\\s*=\\s*([\'\\"])(.*?)\\1','i').exec(tag);if(m)add(m[2]);}
        const srcset=/\bsrcset\s*=\s*(['"])(.*?)\1/i.exec(tag);
        if(srcset)for(const item of srcset[2].split(','))add(item.trim().split(/\s+/)[0]);
      }
    }
    for(const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))out.push(...references('inline.css',match[1]));
    for(const match of text.matchAll(/\bstyle\s*=\s*(['"])(.*?)\1/gi))out.push(...references('inline.css',match[2]));
  }
  if(/\.css$/i.test(path)){
    for(const match of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi))add(match[2]);
    for(const match of text.matchAll(/@import\s+(?:url\()?\s*(['"])(.*?)\1\s*\)?/gi))add(match[2]);
  }
  if(/\.(?:m?js)$/i.test(path)){
    const pattern=/(?:\bimport\s*(?:[^'"]*?\s+from\s*)?|\bimport\s*\(\s*|\bnew\s+URL\s*\(\s*)(['"])([^'"]+)\1/g;
    for(const match of text.matchAll(pattern))add(match[2]);
  }
  return out;
}
async function loadBlob(token,owner,repo,sha,maxBytes){
  const blob=await githubJson(token,`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`,Math.ceil(maxBytes*1.5)+8192);
  if(blob?.encoding!=='base64'||String(blob.sha||'').toLowerCase()!==sha.toLowerCase())throw new Error('GitHub returned a different source blob.');
  const bytes=decodeBase64(blob.content);
  if(bytes.length!==Number(blob.size)||bytes.length>maxBytes)throw new Error('A committed asset exceeds the allowed size.');
  return bytes;
}

/// Captures one static HTML app and its local dependencies from an immutable
/// Git tree. Only safe relative paths and bounded blobs are fetched. The
/// session token never leaves this server module or its GitHub request.
export async function fetchGitHubCommitSource(sessionToken,input){
  const token=tokenValue(sessionToken);
  if(!token)return {error:'Sign in with the connected GitHub account to import a commit.',status:403};
  const owner=String(input?.owner||'').trim(),repo=String(input?.repo||'').trim(),branch=String(input?.branch||'').trim(),requestedSha=String(input?.commitSha||'').toLowerCase();
  if(!safeRepoPart(owner)||!safeRepoPart(repo)||!safeBranch(branch)||!SHA.test(requestedSha))return {error:'Choose a GitHub repository, branch, and full commit SHA.',status:400};
  try{
    const resolved=await currentBranchSha(token,owner,repo,branch);
    if(resolved!==requestedSha)return {error:'The branch no longer points to this commit. Select the current commit and request a new review.',status:409};
    const commit=await githubJson(token,`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${requestedSha}`,256_000);
    if(String(commit?.sha||'').toLowerCase()!==requestedSha||!SHA.test(String(commit?.tree?.sha||'')))return {error:'GitHub returned a different commit.',status:409};
    const tree=await githubJson(token,`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`,1_500_000);
    if(tree?.truncated||!Array.isArray(tree.tree)||tree.tree.length>MAX_TREE_ENTRIES)return {error:'The commit tree is too large to import safely.',status:413};
    const entries=new Map();
    for(const entry of tree.tree){if(entry?.type==='blob'&&['100644','100755'].includes(entry.mode)&&safePath(entry.path)&&SHA.test(String(entry.sha||''))&&Number.isSafeInteger(Number(entry.size))&&Number(entry.size)>=0)entries.set(entry.path,entry);}
    const root=entries.get('index.html');
    if(!root||Number(root.size)>MAX_HTML_BYTES)return {error:'The commit must contain a root index.html under 119800 bytes.',status:400};
    const rootBytes=await loadBlob(token,owner,repo,root.sha,MAX_HTML_BYTES);
    const html=new TextDecoder('utf-8',{fatal:true}).decode(rootBytes);
    if(!html.trim()||html.length>MAX_HTML_BYTES||html.includes('\0'))return {error:'The pinned HTML source is empty, invalid, or too large.',status:400};
    const htmlHash=await sha256(rootBytes);
    const assets=new Map(), queue=references('index.html',html).map(target=>resolveReference('index.html',target)).filter(x=>!x.ignored).map(x=>x.path);
    let total=0;
    while(queue.length){
      const path=queue.shift();if(assets.has(path))continue;
      if(assets.size>=MAX_ASSETS)return {error:'The static app references more than 50 assets.',status:413};
      const entry=entries.get(path);if(!entry)return {error:`A referenced asset is missing from the commit: ${path}`,status:400};
      const mimeType=mimeFor(path);if(!mimeType)return {error:`Unsupported committed asset type: ${path}`,status:415};
      const size=Number(entry.size);if(size>MAX_BUNDLE_BYTES||total+size>MAX_BUNDLE_BYTES)return {error:'The static app bundle exceeds 1.5 MB.',status:413};
      const bytes=await loadBlob(token,owner,repo,entry.sha,MAX_BUNDLE_BYTES);
      const contentHash=await sha256(bytes);total+=bytes.length;
      assets.set(path,{path,mimeType,contentBase64:base64FromBytes(bytes),contentHash,size:bytes.length,blobSha:entry.sha});
      if(mimeType==='text/css'||mimeType==='text/javascript'){
        const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        for(const target of references(path,text)){
          const resolvedPath=resolveReference(path,target);
          if(!resolvedPath.ignored&&!assets.has(resolvedPath.path))queue.push(resolvedPath.path);
        }
      }
    }
    const manifest=['index.html|text/html|'+htmlHash,...[...assets.values()].sort((a,b)=>a.path.localeCompare(b.path)).map(a=>`${a.path}|${a.mimeType}|${a.contentHash}`)].join('\n');
    const sourceHash=await sha256(new TextEncoder().encode(manifest));
    const latest=await currentBranchSha(token,owner,repo,branch);
    if(latest!==requestedSha)return {error:'The branch moved while importing. Select its current commit and request a new review.',status:409};
    return {source:html,assets:[...assets.values()],commit:{owner,repo,branch,sha:requestedSha,path:'index.html',htmlHash,sourceHash,assetToken:crypto.randomUUID(),assets:[...assets.values()].map(({path,mimeType,contentHash,size})=>({path,mimeType,contentHash,size}))}};
  }catch(error){\n    const message=error instanceof Error?error.message:'GitHub source could not be verified.';\n    const invalidSourcePath=/escapes the repository root|External, absolute, and query-based assets are not supported|A GitHub asset path is invalid/.test(message);\n    return {error:message,status:invalidSourcePath?400:502};\n  }
}

export async function verifyGitHubCommitRef(sessionToken,commit){
  const token=tokenValue(sessionToken);
  if(!token)return {error:'Sign in with the connected GitHub account to verify this commit.',status:403};
  if(!commit||!safeRepoPart(commit.owner)||!safeRepoPart(commit.repo)||!safeBranch(commit.branch)||!SHA.test(String(commit.sha||'')))return {error:'The saved GitHub commit source is invalid.',status:409};
  try{
    const sha=await currentBranchSha(token,commit.owner,commit.repo,commit.branch);
    if(sha!==String(commit.sha).toLowerCase())return {error:'The approved branch moved to a different commit. Import and review the new commit.',status:409};
    const pinned=await githubJson(token,`/repos/${encodeURIComponent(commit.owner)}/${encodeURIComponent(commit.repo)}/git/commits/${encodeURIComponent(commit.sha)}`,256_000);
    if(String(pinned?.sha||'').toLowerCase()!==String(commit.sha).toLowerCase())return {error:'The pinned GitHub commit could not be verified.',status:409};
    return {verified:true};
  }catch(error){return {error:error instanceof Error?error.message:'GitHub commit could not be verified.',status:502};}
}
