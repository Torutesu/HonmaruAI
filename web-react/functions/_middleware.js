const DEFAULT_API_HOST = 'tiktokforwork.torubj0904.workers.dev';
const HONMARU_HOSTS = new Set(['app.honmaruai.com', 'honmaruai.com', 'www.honmaruai.com', 'honmaru-web.pages.dev']);

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();
  const appHost = !HONMARU_HOSTS.has(hostname) && !hostname.endsWith('.pages.dev');
  const appPage = request.method === 'GET' && url.pathname === '/';
  const appRunner = request.method === 'GET' && url.pathname === '/custom-app-runner';
  if (!appHost || (!appPage && !appRunner)) return context.next();

  const configuredHost = String(context.env?.API_HOST || DEFAULT_API_HOST).trim();
  const apiHost = /^[a-z0-9.-]+$/i.test(configuredHost) ? configuredHost : DEFAULT_API_HOST;
  const resolve = new URL(appRunner ? '/custom-app-runner' : '/app-domains/resolve', `https://${apiHost}`);
  if (appRunner) resolve.search = url.search;
  else resolve.searchParams.set('host', hostname);
  try {
    const response = await fetch(resolve, { headers: { accept: request.headers.get('accept') || '*/*' }, redirect: 'error' });
    if (response.status === 404 && appPage) return new Response('No published app is available at this domain.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    if (!response.ok) return new Response('The app could not be loaded. Try again later.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' } });
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    headers.set('x-content-type-options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return new Response('The app could not be loaded. Try again later.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' } });
  }
}
