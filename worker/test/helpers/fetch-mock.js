/// `fetchMock` was removed from `cloudflare:test` in vitest-pool-workers 0.22
/// — upstream's migration path is "mock globalThis.fetch yourself", and this
/// is that mock, in the undici MockAgent dialect the suite was written in.
/// SELF and Durable Object stubs never travel through globalThis.fetch, so
/// patching it intercepts only outbound requests, exactly as before.
const pools = new Map(); // origin -> Pool
let realFetch = null;

function matcher(m) {
  if (typeof m === "function") return m;
  if (m instanceof RegExp) return (v) => m.test(v);
  return (v) => v === m;
}

function headersMatch(rule, headers) {
  if (rule === undefined) return true;
  if (typeof rule === "function") return !!rule(headers);
  return Object.entries(rule).every(([k, m]) => matcher(m)(headers[k.toLowerCase()]));
}

class Scope {
  constructor(interceptor) { this.interceptor = interceptor; }
  delay(ms) { this.interceptor.delayMs = ms; return this; }
  persist() { this.interceptor.persist = true; return this; }
  times(n) { this.interceptor.maxTimes = n; return this; }
}

class Pool {
  constructor(origin) { this.origin = origin; this.interceptors = []; }
  intercept(options) {
    const interceptor = {
      path: options.path !== undefined ? matcher(options.path) : () => true,
      method: options.method ? options.method.toUpperCase() : null,
      body: options.body !== undefined ? matcher(options.body) : () => true,
      headers: options.headers,
      consumed: 0, maxTimes: 1, persist: false, delayMs: 0, answer: null,
    };
    const scope = new Scope(interceptor);
    const register = (answer) => { interceptor.answer = answer; this.interceptors.push(interceptor); return scope; };
    return {
      reply(statusOrCallback, data, responseOptions) {
        if (typeof statusOrCallback === "function") {
          return register(async (opts) => {
            const r = await statusOrCallback(opts);
            return { status: r.statusCode ?? 200, data: r.data, options: r.responseOptions };
          });
        }
        return register(async (opts) => ({
          status: statusOrCallback,
          data: typeof data === "function" ? await data(opts) : data,
          options: responseOptions,
        }));
      },
      replyWithError(error) {
        return register(async () => { throw error; });
      },
    };
  }
}

async function mockedFetch(input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const body = await request.text();
  const opts = {
    origin: url.origin,
    path: url.pathname + url.search,
    method: request.method.toUpperCase(),
    headers: Object.fromEntries(request.headers.entries()),
    body,
  };
  const pool = pools.get(url.origin);
  const interceptor = pool?.interceptors.find((i) =>
    (i.persist || i.consumed < i.maxTimes) &&
    (!i.method || i.method === opts.method) &&
    i.path(opts.path) && i.body(opts.body) && headersMatch(i.headers, opts.headers));
  if (!interceptor) {
    throw new Error(`fetchMock: outbound ${opts.method} ${url.href} matched no interceptor`);
  }
  interceptor.consumed += 1;
  if (interceptor.delayMs) await new Promise((r) => setTimeout(r, interceptor.delayMs));
  const { status, data, options } = await interceptor.answer(opts);
  const headers = new Headers(options?.headers || {});
  let payload = data;
  if (typeof data === "object" && data !== null && !(data instanceof Uint8Array)) {
    payload = JSON.stringify(data);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Response(payload, { status, headers });
}

export const fetchMock = {
  activate() {
    if (realFetch) return;
    realFetch = globalThis.fetch;
    globalThis.fetch = mockedFetch;
  },
  deactivate() {
    if (!realFetch) return;
    globalThis.fetch = realFetch;
    realFetch = null;
  },
  get(origin) {
    if (!pools.has(origin)) pools.set(origin, new Pool(origin));
    return pools.get(origin);
  },
  assertNoPendingInterceptors() {
    const pending = [];
    for (const [origin, pool] of pools) {
      for (const i of pool.interceptors) {
        if (!i.persist && i.consumed < i.maxTimes) pending.push(`${origin}`);
      }
    }
    if (pending.length) throw new Error(`fetchMock: ${pending.length} interceptor(s) never matched`);
  },
};
