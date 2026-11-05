import { getTable, listRows } from './tables.js';
import { aad, isSealed, openField, sealField } from '../secrets.js';

const MAX_ENV_VARS = 25;
const MAX_ENV_VALUE = 4000;
const MAX_ENV_TOTAL = 12000;
const MAX_PUBLIC_SNAPSHOT = 1_500_000;
const RESERVED_HOSTS = new Set(['app.honmaruai.com', 'www.honmaruai.com', 'honmaruai.com', 'honmaru-web.pages.dev']);
const error = (message, status = 400) => ({ error: message, status });
const now = () => new Date().toISOString();

export function normalizeAppHostname(value) {
  if (typeof value !== 'string' || value.length > 253 || /[\s/:?#@]/.test(value)) return null;
  let hostname;
  try { hostname = new URL(`https://${value}`).hostname.toLowerCase(); } catch { return null; }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(hostname)) return null;
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.pages.dev') || RESERVED_HOSTS.has(hostname)) return null;
  return hostname;
}

function domainConfig(env) {
  const account = String(env.CF_ACCOUNT_ID || '').trim();
  const project = String(env.CF_PAGES_PROJECT || 'honmaru-web').trim();
  const token = String(env.PAGES_DOMAINS_API_TOKEN || '').trim();
  return { account, project, token, configured: env.ENABLE_APP_DOMAINS !== '0' && Boolean(account && project && token) };
}

async function pagesRequest(env, method, hostname, body) {
  const config = domainConfig(env);
  if (!config.configured) return error('独自ドメイン管理はまだ設定されていません。Cloudflare Pages Write 権限の専用トークンを登録してください。', 503);
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.account)}/pages/projects/${encodeURIComponent(config.project)}/domains`;
  const url = hostname ? `${base}/${encodeURIComponent(hostname)}` : `${base}?per_page=100`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
    });
  } catch {
    return error('Cloudflare Pages に接続できませんでした。', 502);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.success !== true) {
    return { error: 'Cloudflare Pages が独自ドメインの操作を拒否しました。設定を確認して再試行してください。', status: response.status === 404 ? 404 : 502 };
  }
  return { result: result.result };
}

async function envList(db, orgId, appId) {
  const { results = [] } = await db.prepare(
    'SELECT name,version,updated_at AS updatedAt FROM hx_app_env_vars WHERE org_id=?1 AND app_id=?2 ORDER BY name'
  ).bind(orgId, appId).all();
  return results.map(row => ({ ...row, hasValue: true }));
}

export async function readAppHosting(db, env, orgId, appId) {
  const domain = await db.prepare(
    'SELECT hostname,status,validation_status AS validationStatus,verification_status AS verificationStatus,error_message AS errorMessage,created_at AS createdAt,updated_at AS updatedAt FROM hx_app_domains WHERE org_id=?1 AND app_id=?2'
  ).bind(orgId, appId).first();
  const config = domainConfig(env);
  return {
    configured: config.configured,
    project: config.project,
    dnsTarget: `${config.project}.pages.dev`,
    domain: domain ? { ...domain, dnsTarget: `${config.project}.pages.dev` } : null,
    environment: await envList(db, orgId, appId),
  };
}

async function attachDomain(db, env, orgId, app, by, rawHostname) {
  const hostname = normalizeAppHostname(rawHostname);
  if (!hostname) return error('完全なホスト名を入力してください（例: tools.example.com）。', 400);
  if (!app.definition?.custom?.published) return error('独自ドメインを公開する前にカスタムアプリを公開してください。', 409);
  const existing = await db.prepare('SELECT hostname,status FROM hx_app_domains WHERE org_id=?1 AND app_id=?2').bind(orgId, app.id).first();
  if (existing) return error('このアプリにはすでに独自ドメインが設定されています。先に現在のドメインを解除してください。', 409);
  const occupied = await db.prepare('SELECT app_id FROM hx_app_domains WHERE hostname=?1').bind(hostname).first();
  if (occupied) return error('このホスト名は別のアプリで使用されています。', 409);

  // Reserve the hostname before calling Cloudflare so concurrent requests
  // cannot attach one public host to two apps.
  const at = now();
  try {
    await db.prepare("INSERT INTO hx_app_domains(org_id,app_id,hostname,status,created_by,created_at,updated_at) VALUES(?1,?2,?3,'configuring',?4,?5,?5)")
      .bind(orgId, app.id, hostname, String(by), at).run();
  } catch {
    return error('このホスト名またはアプリにはすでに独自ドメインが設定されています。', 409);
  }

  const listed = await pagesRequest(env, 'GET');
  if (listed.error) {
    await db.prepare('DELETE FROM hx_app_domains WHERE org_id=?1 AND app_id=?2 AND hostname=?3').bind(orgId, app.id, hostname).run();
    return listed;
  }
  const providerDomain = (Array.isArray(listed.result) ? listed.result : []).find(item => String(item.name || '').toLowerCase() === hostname);
  if (providerDomain) {
    await db.prepare('DELETE FROM hx_app_domains WHERE org_id=?1 AND app_id=?2 AND hostname=?3').bind(orgId, app.id, hostname).run();
    return error('このホスト名はCloudflare Pagesですでに使用されています。', 409);
  }

  const created = await pagesRequest(env, 'POST', null, { name: hostname });
  if (created.error) {
    await db.prepare('DELETE FROM hx_app_domains WHERE org_id=?1 AND app_id=?2 AND hostname=?3').bind(orgId, app.id, hostname).run();
    return created;
  }
  const status = String(created.result?.status || 'pending').toLowerCase();
  const allowedStatus = new Set(['initializing','pending','active','deactivated','blocked','error']);
  await db.prepare('UPDATE hx_app_domains SET status=?3,validation_status=?4,verification_status=?5,error_message=?6,updated_at=?7 WHERE org_id=?1 AND app_id=?2 AND hostname=?8')
    .bind(orgId, app.id, allowedStatus.has(status) ? status : 'pending', String(created.result?.validation_data?.status || 'pending'), String(created.result?.verification_data?.status || 'pending'), String(created.result?.validation_data?.error_message || created.result?.verification_data?.error_message || ''), at, hostname).run();
  return readAppHosting(db, env, orgId, app.id);
}

async function refreshDomain(db, env, orgId, appId) {
  const existing = await db.prepare('SELECT hostname FROM hx_app_domains WHERE org_id=?1 AND app_id=?2').bind(orgId, appId).first();
  if (!existing) return error('独自ドメインは設定されていません。', 404);
  const listed = await pagesRequest(env, 'GET');
  if (listed.error) return listed;
  const providerDomain = (Array.isArray(listed.result) ? listed.result : []).find(item => String(item.name || '').toLowerCase() === existing.hostname);
  if (!providerDomain) {
    await db.prepare("UPDATE hx_app_domains SET status='error',error_message='Domain is no longer attached to the Pages project.',updated_at=?3 WHERE org_id=?1 AND app_id=?2").bind(orgId, appId, now()).run();
    return readAppHosting(db, env, orgId, appId);
  }
  const status = String(providerDomain.status || 'pending').toLowerCase();
  const allowedStatus = new Set(['initializing','pending','active','deactivated','blocked','error']);
  await db.prepare('UPDATE hx_app_domains SET status=?3,validation_status=?4,verification_status=?5,error_message=?6,updated_at=?7 WHERE org_id=?1 AND app_id=?2')
    .bind(orgId, appId, allowedStatus.has(status) ? status : 'pending', String(providerDomain.validation_data?.status || 'pending'), String(providerDomain.verification_data?.status || 'pending'), String(providerDomain.validation_data?.error_message || providerDomain.verification_data?.error_message || ''), now()).run();
  return readAppHosting(db, env, orgId, appId);
}

async function removeDomain(db, env, orgId, appId) {
  const existing = await db.prepare('SELECT hostname FROM hx_app_domains WHERE org_id=?1 AND app_id=?2').bind(orgId, appId).first();
  if (!existing) return readAppHosting(db, env, orgId, appId);
  const result = await pagesRequest(env, 'DELETE', existing.hostname);
  if (result.error && result.status !== 404) return result;
  await db.prepare('DELETE FROM hx_app_domains WHERE org_id=?1 AND app_id=?2 AND hostname=?3').bind(orgId, appId, existing.hostname).run();
  return readAppHosting(db, env, orgId, appId);
}

function validEnvName(value) {
  const name = String(value || '').trim().toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) || ['__PROTO__','CONSTRUCTOR','PROTOTYPE','PATH','HOME','PWD','TMPDIR','NODE_OPTIONS'].includes(name) || name.startsWith('HONMARU_')) return null;
  return name;
}

async function updateEnvironment(db, orgId, appId, input, by) {
  const name = validEnvName(input.name);
  if (!name) return error('環境変数名は英大文字・数字・_で入力してください。');
  const old = await db.prepare('SELECT version,value FROM hx_app_env_vars WHERE org_id=?1 AND app_id=?2 AND name=?3').bind(orgId, appId, name).first();
  const currentVersion = Number(old?.version || 0);
  if (!Number.isSafeInteger(input.version) || input.version !== currentVersion) return error('環境変数が別の画面で変更されました。再読み込みしてください。', 409);
  if (typeof input.value !== 'string' || !input.value.length || input.value.length > MAX_ENV_VALUE) return error(`値は1〜${MAX_ENV_VALUE}文字で入力してください。`);
  const { results = [] } = await db.prepare('SELECT name,value FROM hx_app_env_vars WHERE org_id=?1 AND app_id=?2').bind(orgId, appId).all();
  if (!old && results.length >= MAX_ENV_VARS) return error(`環境変数は1アプリにつき${MAX_ENV_VARS}個までです。`, 409);
  let total = 0;
  for (const row of results) {
    if (row.name === name) continue;
    const value = await openField(row.value, aad.appEnvironment(orgId, appId, row.name));
    if (typeof value === 'string') total += value.length;
  }
  if (total + input.value.length > MAX_ENV_TOTAL) return error(`環境変数の合計は${MAX_ENV_TOTAL}文字までです。`, 413);
  const encrypted = await sealField(input.value, aad.appEnvironment(orgId, appId, name), orgId);
  if (!isSealed(encrypted)) return error('暗号化保存の準備ができていません。管理者に問い合わせてください。', 503);
  const version = currentVersion + 1;
  const at = now();
  const saved = old
    ? await db.prepare('UPDATE hx_app_env_vars SET value=?4,version=?5,updated_by=?6,updated_at=?7 WHERE org_id=?1 AND app_id=?2 AND name=?3 AND version=?8')
      .bind(orgId, appId, name, encrypted, version, String(by), at, currentVersion).run()
    : await db.prepare('INSERT OR IGNORE INTO hx_app_env_vars(org_id,app_id,name,value,version,updated_by,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)')
      .bind(orgId, appId, name, encrypted, version, String(by), at).run();
  return saved.meta?.changes ? { saved: true, name, version } : error('環境変数が別の画面で変更されました。再読み込みしてください。', 409);
}

async function deleteEnvironment(db, orgId, appId, input) {
  const name = validEnvName(input.name);
  if (!name) return error('環境変数名が正しくありません。');
  const removed = await db.prepare('DELETE FROM hx_app_env_vars WHERE org_id=?1 AND app_id=?2 AND name=?3 AND version=?4')
    .bind(orgId, appId, name, Number(input.version)).run();
  return removed.meta?.changes ? { deleted: true } : error('環境変数が別の画面で変更されました。再読み込みしてください。', 409);
}

export async function changeAppHosting(db, env, orgId, app, input, by) {
  if (input.action === 'attach') {
    if (input.publicDataConfirmed !== true) return error('公開前に、アプリのカスタム画面と全レコードが誰でも閲覧できることを確認してください。', 409);
    return attachDomain(db, env, orgId, app, by, input.hostname);
  }
  if (input.action === 'refresh') return refreshDomain(db, env, orgId, app.id);
  if (input.action === 'remove') return removeDomain(db, env, orgId, app.id);
  if (input.action === 'set_env') return updateEnvironment(db, orgId, app.id, input, by);
  if (input.action === 'delete_env') return deleteEnvironment(db, orgId, app.id, input);
  return error('Unknown hosting operation.');
}

function escaped(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export async function servePublicAppDomain(request, env, url) {
  if (request.method !== 'GET') return new Response('Method not allowed.', { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
  const hostname = normalizeAppHostname(url.searchParams.get('host') || '');
  if (!hostname) return new Response('Not found.', { status: 404, headers: { 'cache-control': 'no-store' } });
  const domain = await env.DB.prepare(`SELECT d.org_id AS orgId,d.app_id AS appId,a.name,a.icon,a.table_id AS tableId,a.definition
    FROM hx_app_domains d JOIN hx_apps a ON a.org_id=d.org_id AND a.id=d.app_id
    WHERE d.hostname=?1 AND d.status='active'`).bind(hostname).first();
  if (!domain) return new Response('No published app is available at this domain.', { status: 404, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
  let definition;
  try { definition = JSON.parse(domain.definition || '{}'); } catch { definition = {}; }
  const html = definition.custom?.published;
  if (typeof html !== 'string' || !html.trim() || html.length > 119800) return new Response('No published app is available at this domain.', { status: 404, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
  const table = await getTable(env.DB, domain.orgId, domain.tableId);
  if (!table) return new Response('The app data is unavailable.', { status: 503, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
  const result = await listRows(env.DB, domain.orgId, domain.tableId, { limit: 5000 });
  if (result.error) return new Response('The app data is unavailable.', { status: 503, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
  const entities = [{ key: 'primary', table, rows: result.rows || [] }];
  const related = await env.DB.prepare('SELECT entity_key AS key,table_id AS tableId FROM hx_app_entities WHERE org_id=?1 AND app_id=?2 ORDER BY entity_key').bind(domain.orgId, domain.appId).all();
  for (const entity of related.results || []) {
    if (entity.key === 'primary' || entity.tableId === domain.tableId) continue;
    const otherTable = await getTable(env.DB, domain.orgId, entity.tableId);
    const otherRows = otherTable && await listRows(env.DB, domain.orgId, entity.tableId, { limit: 5000 });
    if (otherTable && !otherRows.error) entities.push({ key: entity.key, table: otherTable, rows: otherRows.rows || [] });
  }
  const payload = { app: { name: domain.name, icon: domain.icon || '📋' }, table, rows: result.rows || [], entities };
  const json = scriptJson(payload);
  if (json.length > MAX_PUBLIC_SNAPSHOT) return new Response('The app data is too large to publish on a single page.', { status: 413, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
  const runner = `${url.origin}/custom-app-runner?v=4`;
  const publishedCommit=definition.custom?.publishedCommit;
  const commitAssetBase=publishedCommit?.sha&&publishedCommit?.assetToken
    ?`${url.origin}/app-commit-assets/${encodeURIComponent(domain.appId)}/${encodeURIComponent(publishedCommit.sha)}/${encodeURIComponent(publishedCommit.assetToken)}/`
    :'';
  // The sandboxed srcdoc has an opaque origin, so 'self' cannot authorize
  // captured assets. Permit only this app/commit/token path from this origin.
  const assetSource=commitAssetBase||"'self'";
  const assetPolicy=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${assetSource}; style-src 'unsafe-inline' ${assetSource}; img-src ${assetSource} data:; font-src ${assetSource} data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri ${assetSource}">`;
  const assetBase=commitAssetBase?`<base href="${escaped(commitAssetBase)}">`:'';
  const title = escaped(domain.name || 'App');
  const body = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#172033}header{height:48px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #e2e8f0;background:white}header strong{font-size:14px;font-weight:600}header span{font-size:18px}iframe{display:block;width:100%;height:calc(100dvh - 49px);border:0}</style></head><body><header><span>${escaped(domain.icon || '📋')}</span><strong>${title}</strong></header><iframe id="runner" title="${title}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${escaped(runner)}"></iframe><script>
const snapshot=${json};const frame=document.getElementById('runner');let initialized=false;
function reply(id,value,error){frame.contentWindow.postMessage({type:'honmaru:result',id,value,error},'*')}
addEventListener('message',event=>{if(event.source!==frame.contentWindow||!event.data)return;const m=event.data;if(m.type==='honmaru:ready'&&!initialized){initialized=true;frame.contentWindow.postMessage({type:'honmaru:init',renderId:crypto.randomUUID(),theme:'system',html:snapshotHtml},'*');return}if(m.type!=='honmaru:request'||typeof m.id!=='string'||m.id.length>80)return;const args=m.args&&typeof m.args==='object'?m.args:{};if(m.operation==='read'){reply(m.id,{table:snapshot.table,rows:snapshot.rows});return}if(m.operation==='entity'){const entity=snapshot.entities.find(item=>item.key===args.entity);entity?reply(m.id,{table:entity.table,rows:entity.rows}):reply(m.id,undefined,'No such entity.');return}reply(m.id,undefined,'Published apps on this domain are read-only.')});
const snapshotHtml=${scriptJson(`${assetPolicy}${assetBase}<meta name="color-scheme" content="light dark"><style>body{background:Canvas;color:CanvasText}</style>${html}`)};
</script></body></html>`;
  return new Response(body, { headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src ${url.origin}; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'cache-control': 'no-store',
  } });
}
