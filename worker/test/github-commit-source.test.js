import { afterEach, expect, test, vi } from 'vitest';
import { fetchGitHubCommitSource, verifyGitHubCommitRef } from '../src/harness/githubCommitSource.js';

const commitSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const rootBlob = 'c'.repeat(40);
const jsBlob = 'd'.repeat(40);
const base64 = (value) => btoa(value);
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const responseFor = (url, refSha = commitSha, html = '<script src="./app.js"></script>', js = 'document.body.dataset.ready="yes";') => {
  const path = new URL(url).pathname;
  if (path.endsWith('/git/ref/heads/main')) return json({ object: { sha: refSha } });
  if (path.endsWith('/git/commits/' + commitSha)) return json({ sha: commitSha, tree: { sha: treeSha } });
  if (path.endsWith('/git/trees/' + treeSha)) return json({ truncated: false, tree: [
    { type: 'blob', mode: '100644', path: 'index.html', sha: rootBlob, size: new TextEncoder().encode(html).length },
    { type: 'blob', mode: '100644', path: 'app.js', sha: jsBlob, size: new TextEncoder().encode(js).length },
  ] });
  if (path.endsWith('/git/blobs/' + rootBlob)) return json({ encoding: 'base64', sha: rootBlob, size: new TextEncoder().encode(html).length, content: base64(html) });
  if (path.endsWith('/git/blobs/' + jsBlob)) return json({ encoding: 'base64', sha: jsBlob, size: new TextEncoder().encode(js).length, content: base64(js) });
  return new Response('unexpected request', { status: 404 });
};
afterEach(() => vi.unstubAllGlobals());

test('imports immutable HTML and recursively captures same-commit relative JS assets', async () => {
  const fetch = vi.fn(async (url) => responseFor(url));
  vi.stubGlobal('fetch', fetch);
  const result = await fetchGitHubCommitSource('gho-never-return-this', { owner: 'acme', repo: 'app', branch: 'main', commitSha });
  expect(result.source).toContain('./app.js');
  expect(result.commit.sha).toBe(commitSha);
  expect(result.assets.map((asset) => asset.path)).toEqual(['app.js']);
  expect(result.commit.assets).toEqual([{ path: 'app.js', mimeType: 'text/javascript', contentHash: expect.any(String), size: 34 }]);
  expect(JSON.stringify(result)).not.toContain('gho-never-return-this');
  expect(fetch.mock.calls.every(([url]) => String(url).startsWith('https://api.github.com/'))).toBe(true);
});

test('rejects a branch moved before or during import', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => responseFor(url, String(url).includes('/git/ref/heads/') && fetch.mock.calls.length > 1 ? 'e'.repeat(40) : commitSha)));
  const result = await fetchGitHubCommitSource('token', { owner: 'acme', repo: 'app', branch: 'main', commitSha });
  expect(result).toMatchObject({ status: 409 });
});

test('rejects traversal references and missing assets without fetching arbitrary paths', async () => {
  const fetch = vi.fn(async (url) => responseFor(url, commitSha, '<script src="../secret.js"></script>'));
  vi.stubGlobal('fetch', fetch);
  const result = await fetchGitHubCommitSource('token', { owner: 'acme', repo: 'app', branch: 'main', commitSha });
  expect(result).toMatchObject({ status: 400 });
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/git/blobs/'))).toHaveLength(1);
});

test('rejects oversized tree and root blobs before returning any content', async () => {
  const fetch = vi.fn(async (url) => String(url).includes('/git/trees/')
    ? json({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'index.html', sha: rootBlob, size: 119801 }] })
    : responseFor(url));
  vi.stubGlobal('fetch', fetch);
  const result = await fetchGitHubCommitSource('token', { owner: 'acme', repo: 'app', branch: 'main', commitSha });
  expect(result).toMatchObject({ status: 400 });
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/git/blobs/' + rootBlob))).toBe(false);
});

test('verifies the branch still resolves to the approved full commit SHA', async () => {
  const fetch = vi.fn(async (url) => responseFor(url));
  vi.stubGlobal('fetch', fetch);
  await expect(verifyGitHubCommitRef('token', { owner: 'acme', repo: 'app', branch: 'main', sha: commitSha })).resolves.toEqual({ verified: true });
  vi.stubGlobal('fetch', vi.fn(async (url) => responseFor(url, 'f'.repeat(40))));
  await expect(verifyGitHubCommitRef('token', { owner: 'acme', repo: 'app', branch: 'main', sha: commitSha })).resolves.toMatchObject({ status: 409 });
});


test('rejects a branch that already moved before import starts', async () => {
  const fetch = vi.fn(async (url) => String(url).includes('/git/ref/heads/')
    ? json({ object: { sha: 'e'.repeat(40) } })
    : responseFor(url));
  vi.stubGlobal('fetch', fetch);
  const result = await fetchGitHubCommitSource('token', { owner: 'acme', repo: 'app', branch: 'main', commitSha });
  expect(result).toMatchObject({ status: 409 });
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/git/commits/'))).toBe(false);
});

test('returns a clear missing-asset error without attempting an upstream fetch for that path', async () => {
  const fetch = vi.fn(async (url) => responseFor(url, commitSha, '<script src="./missing.js"></script>'));
  vi.stubGlobal('fetch', fetch);
  const result = await fetchGitHubCommitSource('token', { owner: 'acme', repo: 'app', branch: 'main', commitSha });
  expect(result).toMatchObject({ status: 400, error: expect.stringContaining('missing.js') });
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/git/blobs/'))).toHaveLength(1);
});

test('recursively captures JavaScript imports, CSS imports, and CSS image references', async () => {
  const ids = { html: '1'.repeat(40), js: '2'.repeat(40), css: '3'.repeat(40), image: '4'.repeat(40) };
  const source = {
    'index.html': '<script src="./src/app.js"></script>',
    'src/app.js': "import '../styles/site.css';",
    'styles/site.css': "body{background:url('../assets/logo.png')}",
  };
  const image = Uint8Array.from([137, 80, 78, 71]);
  const blobs = { ...source, 'assets/logo.png': image };
  const fetch = vi.fn(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/git/ref/heads/main')) return json({ object: { sha: commitSha } });
    if (path.endsWith('/git/commits/' + commitSha)) return json({ sha: commitSha, tree: { sha: treeSha } });
    if (path.endsWith('/git/trees/' + treeSha)) return json({ truncated: false, tree: [
      ['index.html','html'],['src/app.js','js'],['styles/site.css','css'],['assets/logo.png','image'],
    ].map(([file,key]) => ({ type:'blob',mode:'100644',path:file,sha:ids[key],size:typeof blobs[file]==='string'?new TextEncoder().encode(blobs[file]).length:blobs[file].length })) });
    for (const [key,sha] of Object.entries(ids)) if (path.endsWith('/git/blobs/' + sha)) {
      const filePath = ({html:'index.html',js:'src/app.js',css:'styles/site.css',image:'assets/logo.png'})[key];
      const raw = blobs[filePath];
      const bytes = typeof raw==='string'?new TextEncoder().encode(raw):raw;
      return json({encoding:'base64',sha,size:bytes.length,content:btoa(String.fromCharCode(...bytes))});
    }
    return new Response('',{status:404});
  });
  vi.stubGlobal('fetch', fetch);
  const result = await fetchGitHubCommitSource('token', { owner:'acme',repo:'app',branch:'main',commitSha });
  expect(result.commit.assets.map((asset)=>asset.path).sort()).toEqual(['assets/logo.png','src/app.js','styles/site.css']);
  expect(result.assets.find((asset)=>asset.path==='assets/logo.png')).toMatchObject({mimeType:'image/png',size:4});
});

test('cancels a streamed GitHub tree response once it exceeds the byte cap', async () => {
  const fetch = vi.fn(async (input) => {
    if (String(input).includes('/git/trees/')) {
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(1_000_000));
        controller.enqueue(new Uint8Array(600_001));
        controller.close();
      } });
      return new Response(stream, { headers: { 'content-type':'application/json' } });
    }
    return responseFor(input);
  });
  vi.stubGlobal('fetch', fetch);
  const result = await fetchGitHubCommitSource('token', { owner:'acme',repo:'app',branch:'main',commitSha });
  expect(result).toMatchObject({status:502,error:expect.stringContaining('exceeds the size limit')});
});


test('accepts wrapped base64 content from GitHub blobs', async () => {
  const html='<p>Wrapped encoding</p>';
  const fetch=vi.fn(async (input)=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/git/ref/heads/main'))return json({object:{sha:commitSha}});
    if(path.endsWith('/git/commits/'+commitSha))return json({sha:commitSha,tree:{sha:treeSha}});
    if(path.endsWith('/git/trees/'+treeSha))return json({truncated:false,tree:[{type:'blob',mode:'100644',path:'index.html',sha:rootBlob,size:new TextEncoder().encode(html).length}]});
    if(path.endsWith('/git/blobs/'+rootBlob)){
      const encoded=base64(html);
      return json({encoding:'base64',sha:rootBlob,size:new TextEncoder().encode(html).length,content:encoded.replace(/(.{8})/g,'$1\\n')});
    }
    return new Response('',{status:404});
  });
  vi.stubGlobal('fetch',fetch);
  const result=await fetchGitHubCommitSource('token',{owner:'acme',repo:'app',branch:'main',commitSha});
  expect(result.source).toBe(html);
});

test('rejects an oversized referenced JavaScript asset before downloading its blob', async () => {
  const html='<script src="./bundle.js"></script>';
  const huge='f'.repeat(40);
  const fetch=vi.fn(async(input)=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/git/ref/heads/main'))return json({object:{sha:commitSha}});
    if(path.endsWith('/git/commits/'+commitSha))return json({sha:commitSha,tree:{sha:treeSha}});
    if(path.endsWith('/git/trees/'+treeSha))return json({truncated:false,tree:[
      {type:'blob',mode:'100644',path:'index.html',sha:rootBlob,size:new TextEncoder().encode(html).length},
      {type:'blob',mode:'100644',path:'bundle.js',sha:huge,size:1_500_001},
    ]});
    if(path.endsWith('/git/blobs/'+rootBlob))return json({encoding:'base64',sha:rootBlob,size:new TextEncoder().encode(html).length,content:base64(html)});
    return new Response('',{status:404});
  });
  vi.stubGlobal('fetch',fetch);
  const result=await fetchGitHubCommitSource('token',{owner:'acme',repo:'app',branch:'main',commitSha});
  expect(result).toMatchObject({status:413,error:expect.stringContaining('bundle exceeds')});
  expect(fetch.mock.calls.some(([url])=>String(url).endsWith('/git/blobs/'+huge))).toBe(false);
});
