/**
 * Checks a live Bud deployment — the things that cannot be tested locally,
 * because they are properties of the hosts and the proxy between them.
 *
 *   node scripts/verify-deploy.mjs --app https://bud.vercel.app --api https://bud-api.onrender.com
 *
 * Add real credentials to also prove the session survives the proxy, which is
 * what the whole $0 arrangement rests on. They are read from the environment,
 * never from the command line, so they stay out of shell history:
 *
 *   $env:BUD_EMAIL = "you@example.com"; $env:BUD_PASSWORD = "..."
 *
 * Read-only: it signs in, reads, and signs out again. It never writes course
 * content or changes settings.
 */

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg, i, all) => (arg.startsWith('--') ? [arg.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);

const app = (args.app ?? '').replace(/\/+$/, '');
const api = (args.api ?? '').replace(/\/+$/, '');

if (!app || !api) {
  console.error('Usage: node scripts/verify-deploy.mjs --app <vercel url> --api <render url>');
  process.exit(1);
}

let failures = 0;
let warnings = 0;

const report = (state, name, detail = '') => {
  const mark = { ok: 'ok  ', fail: 'FAIL', warn: 'warn', info: '·   ' }[state];
  if (state === 'fail') failures += 1;
  if (state === 'warn') warnings += 1;
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** A fetch that never follows redirects and never throws. */
async function call(url, options = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: 'manual', ...options });
    return { response, ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
}

console.log(`app ${app}\napi ${api}\n`);

// ── the API itself ──────────────────────────────────────────────────────────
console.log('The API, directly');
{
  const { response, ms, error } = await call(`${api}/health`);
  if (error) {
    report('fail', 'GET /health', error.message);
  } else {
    report(response.status === 200 ? 'ok' : 'fail', 'GET /health', `${response.status} in ${ms} ms`);
    report(
      response.headers.get('cache-control') === 'no-store' ? 'ok' : 'fail',
      'health is uncacheable',
      response.headers.get('cache-control') ?? 'no header',
    );
    if (ms > 20_000) {
      report('info', 'that was a cold start', 'the next request should be quick');
    }
  }
}
{
  // /ready checks Postgres and object storage, so this is the real proof that
  // Neon and the bucket are reachable from Render.
  const { response, ms, error } = await call(`${api}/ready`);
  if (error) {
    report('fail', 'GET /ready', error.message);
  } else {
    const body = await response.json().catch(() => ({}));
    report(
      response.status === 200 ? 'ok' : 'fail',
      'GET /ready (database + storage)',
      `${response.status} in ${ms} ms, checks: ${JSON.stringify(body.checks ?? {})}`,
    );
  }
}

// ── who the API thinks is calling ───────────────────────────────────────────
console.log('\nWho the API thinks you are');
{
  // Not observable directly, but the rate limiter answers it for free: it keys
  // on the caller's address and reports what is left of that bucket in its own
  // headers. So: two requests, the second claiming to come from somewhere else.
  // If that buys a fresh allowance, X-Forwarded-For is believed from outside,
  // and then nobody is rate limited and the ten-failures brake on sign-in is a
  // formality. TRUST_PROXY decides this; the README says how to set it.
  //
  // Against a local API this proves nothing and must not cry wolf: the caller
  // is then on loopback, which is a trusted proxy position by design, so the
  // header is believed and should be. Only a run against a real host answers
  // the question.
  const remainingOf = (response) => Number(response?.headers.get('x-ratelimit-remaining'));
  const host = new URL(api).hostname;
  const isLocal =
    ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) ||
    /^10\.|^127\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);

  const plain = await call(`${api}/courses`);
  const claiming = await call(`${api}/courses`, {
    headers: { 'x-forwarded-for': '203.0.113.99' },
  });

  const before = remainingOf(plain.response);
  const after = remainingOf(claiming.response);

  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    report('warn', 'the rate limiter reports no bucket', 'no x-ratelimit-remaining header');
  } else if (after < before) {
    report(
      'ok',
      'a forged X-Forwarded-For buys no new rate-limit bucket',
      `one bucket: ${before} then ${after} left`,
    );
  } else if (isLocal) {
    report(
      'info',
      'a forged X-Forwarded-For is believed over loopback, which is correct',
      'run this against the deployed API to learn anything',
    );
  } else {
    report(
      'fail',
      'a forged X-Forwarded-For buys a new rate-limit bucket',
      `${before} then ${after} left — anyone can opt out of the rate limit and of the ` +
        'sign-in brake. Set TRUST_PROXY to name the proxy in front of this API.',
    );
  }
}

// ── course content, and its isolation ───────────────────────────────────────
console.log('\nCourse content');
{
  const { response, error } = await call(`${api}/nope/1.0.0/index.html`);
  if (error) {
    report('fail', 'course path reaches the course server', error.message);
  } else {
    // 404 from the course server, not the API's JSON envelope: proves the
    // shared-port dispatch is routing by path.
    const isText = (response.headers.get('content-type') ?? '').startsWith('text/plain');
    report(
      response.status === 404 && isText ? 'ok' : 'warn',
      'unknown course 404s from the course server',
      `${response.status} ${response.headers.get('content-type') ?? ''}`,
    );
  }
}
if (args.course) {
  const { response, error } = await call(`${api}${args.course}`);
  if (error) {
    report('fail', 'published course page', error.message);
  } else {
    const csp = response.headers.get('content-security-policy') ?? '';
    report(response.status === 200 ? 'ok' : 'fail', 'published course page', `${response.status}`);
    report(
      /(^|; )sandbox allow-scripts allow-forms allow-modals(;|$)/.test(csp) ? 'ok' : 'fail',
      'course page is sandboxed',
      csp ? 'CSP present' : 'no CSP',
    );
    report(
      csp.includes("connect-src 'none'") ? 'ok' : 'fail',
      'course cannot make network requests',
    );
    report(
      (response.headers.get('cache-control') ?? '').includes('immutable') ? 'ok' : 'warn',
      'course page is cacheable forever',
    );
  }
} else {
  report('info', 'pass --course /<slug>/<version>/<file> to check a real page');
}

// ── the app, and the proxy between them ─────────────────────────────────────
console.log('\nThe app, and the /api proxy');
{
  const { response, ms, error } = await call(app);
  if (error) {
    report('fail', 'GET the app', error.message);
  } else {
    report(response.status < 400 ? 'ok' : 'fail', 'GET the app', `${response.status} in ${ms} ms`);
  }
}
{
  const { response, ms, error } = await call(`${app}/api/health`);
  if (error) {
    report('fail', 'the proxy reaches the API', error.message);
  } else {
    const body = await response.text();
    const isApi = body.includes('"status"');
    report(
      response.status === 200 && isApi ? 'ok' : 'fail',
      'GET /api/health through the proxy',
      `${response.status} in ${ms} ms${isApi ? '' : ' — not the API’s response'}`,
    );
  }
}
{
  // Course paths must not be reachable through the app's own origin.
  const { response, error } = await call(`${app}/api/nope/1.0.0/index.html`);
  if (!error) {
    const body = await response.text();
    const servedCourse = response.headers.get('content-security-policy')?.includes('sandbox');
    report(
      servedCourse ? 'warn' : 'ok',
      'course paths are not proxied through the app',
      servedCourse ? 'the rewrite forwards them' : `${response.status}`,
    );
    void body;
  }
}
{
  // How big a request body the proxy allows, which decides the real ceiling on
  // course uploads. POSTing to /api/health needs no credentials.
  for (const mb of [1, 4, 8]) {
    const { response, error } = await call(`${app}/api/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(mb * 1024 * 1024),
    });
    if (error) {
      report('info', `${mb} MB body through the proxy`, error.message);
    } else {
      report(
        response.status === 413 ? 'info' : 'ok',
        `${mb} MB body through the proxy`,
        response.status === 413 ? 'rejected (413) — uploads are capped below this' : `${response.status} (accepted)`,
      );
    }
  }
}

// ── the session, end to end ─────────────────────────────────────────────────
console.log('\nSigning in through the proxy');
if (process.env.BUD_EMAIL && process.env.BUD_PASSWORD) {
  const login = await call(`${app}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.BUD_EMAIL, password: process.env.BUD_PASSWORD }),
  });

  if (login.error) {
    report('fail', 'sign in', login.error.message);
  } else {
    report(login.response.status === 200 ? 'ok' : 'fail', 'sign in', `${login.response.status}`);
    const cookie = (login.response.headers.get('set-cookie') ?? '').split(';')[0];

    // Undocumented by Vercel, and the whole arrangement depends on it: does
    // Set-Cookie survive the proxy, and arrive host-only on the app's origin?
    const raw = login.response.headers.get('set-cookie') ?? '';
    report(raw ? 'ok' : 'fail', 'Set-Cookie survives the proxy', raw ? raw.split('=')[0] : 'no header');
    report(!/domain=/i.test(raw) ? 'ok' : 'fail', 'the cookie is host-only (no Domain)');
    report(/httponly/i.test(raw) ? 'ok' : 'fail', 'the cookie is HttpOnly');
    report(/secure/i.test(raw) ? 'ok' : 'fail', 'the cookie is Secure');
    report(/samesite=lax/i.test(raw) ? 'ok' : 'warn', 'the cookie is SameSite=Lax', raw.match(/samesite=\w+/i)?.[0] ?? 'not set');

    if (cookie && cookie.includes('=') && !cookie.endsWith('=')) {
      const me = await call(`${app}/api/me`, { headers: { cookie } });
      report(
        me.response?.status === 200 ? 'ok' : 'fail',
        'the session works on the next request',
        `GET /api/me -> ${me.response?.status ?? me.error?.message}`,
      );

      const dashboard = await call(`${app}/api/me/dashboard`, { headers: { cookie } });
      const body = await dashboard.response?.json().catch(() => null);
      report(
        dashboard.response?.status === 200 ? 'ok' : 'fail',
        'the dashboard loads through the proxy',
        body ? `${body.courses?.length ?? 0} course(s), streak ${body.streak?.current ?? '?'}` : '',
      );

      await call(`${app}/api/auth/logout`, { method: 'POST', headers: { cookie } });
      report('info', 'signed out again');
    } else {
      report('fail', 'sign-in returned no session cookie');
    }
  }
} else {
  report(
    'info',
    'set BUD_EMAIL and BUD_PASSWORD to check a real sign-in',
    'the cookie round trip cannot be checked without one — signing out needs a session',
  );
}

console.log(
  `\n${failures === 0 ? 'No failures' : `${failures} failure(s)`}${warnings ? `, ${warnings} warning(s)` : ''}.`,
);
process.exit(failures === 0 ? 0 : 1);
