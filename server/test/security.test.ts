/** Security regression tests. Each test pins down a specific vulnerability class. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, type Client } from './helpers.js';
import { isPrivateAddress } from '../src/lib/net.js';
import { redactUrl } from '../src/app.js';

let app: Awaited<ReturnType<typeof testApp>>;
let owner: Client;
let pid: number;

before(async () => {
  // Production-like: private webhook targets blocked.
  app = await testApp({ webhookAllowPrivate: false });
  owner = await signup(app, 'Sec Owner');
  pid = (await owner.post('/projects', { name: 'Sec' })).id;
});
after(async () => app.cleanup());

async function login(email: string, password = 'password123') {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  return res.cookies.find((c) => c.name === 'tracker_session')!.value;
}

// ---------------------------------------------------------------------------------------- mass assignment

test('unknown body fields cannot write arbitrary columns (mass assignment)', async () => {
  const before = await owner.get(`/projects/${pid}`);
  const r = await owner.req('PUT', `/projects/${pid}`, { name: 'Renamed', version: 99999, created_at: 'hacked', id: 777 });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Renamed');
  assert.notEqual(r.body.version, 99999 + 1);
  assert.equal(r.body.created_at, before.created_at);
  assert.equal(r.body.id, pid);
});

test('body keys can never reach SQL as identifiers', async () => {
  const r = await owner.req('PUT', `/projects/${pid}`, { "name = 'pwned' WHERE 1=1; --": 1 });
  assert.ok(r.status < 500, `got ${r.status}`);
  assert.notEqual((await owner.get(`/projects/${pid}`)).name, 'pwned');
});

test('database helpers reject unsafe identifiers', () => {
  assert.throws(() => app.ctx.db.update('projects', pid, { 'name = 1; --': 'x' } as any), /identifier/);
  assert.throws(() => app.ctx.db.insert('projects; DROP TABLE users', { name: 'x' }), /identifier/);
});

// ---------------------------------------------------------------------------------------- CSRF

test('cookie-authenticated mutations require a same-origin Origin header (CSRF)', async () => {
  const cookie = await login(owner.user.email);
  const attempt = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: `/api/v1/projects/${pid}/stories`, cookies: { tracker_session: cookie }, headers, payload: { name: 'csrf' } });
  assert.equal((await attempt({ origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await attempt({})).statusCode, 403, 'missing Origin and Referer is rejected');
  assert.equal((await attempt({ referer: 'https://evil.example/page' })).statusCode, 403);
  assert.equal((await attempt({ origin: 'http://tracker.test' })).statusCode, 201);
  // Safe methods and token-authenticated API clients are unaffected.
  const get = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { tracker_session: cookie } });
  assert.equal(get.statusCode, 200);
  assert.equal((await owner.req('POST', `/projects/${pid}/stories`, { name: 'token client' }, { origin: 'https://evil.example' })).status, 201);
});

// ---------------------------------------------------------------------------------------- SSRF

test('webhooks cannot target private, loopback or link-local addresses (SSRF)', async () => {
  for (const url of [
    'http://127.0.0.1:8080/x',
    'http://localhost/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://0.0.0.0/',
    'http://2130706433/', // 127.0.0.1 as an integer
  ]) {
    const r = await owner.req('POST', `/projects/${pid}/webhooks`, { url });
    assert.equal(r.status, 400, `${url} should be rejected, got ${r.status}`);
  }
  assert.equal((await owner.req('POST', `/projects/${pid}/webhooks`, { url: 'https://93.184.215.14/hook', enabled: false })).status, 201);
});

test('private address classifier', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '224.0.0.1']) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '93.184.215.14', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});

// ---------------------------------------------------------------------------------------- headers & logs

test('responses carry hardening headers', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/instance' });
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
});

test('API tokens in query strings are redacted from logs', () => {
  assert.equal(redactUrl('/api/v1/events?project_ids=1&token=secret123'), '/api/v1/events?project_ids=1&token=[REDACTED]');
  assert.equal(redactUrl('/api/v1/integrations/vcs?token=abc'), '/api/v1/integrations/vcs?token=[REDACTED]');
  assert.equal(redactUrl('/api/v1/projects'), '/api/v1/projects');
});

// ---------------------------------------------------------------------------------------- sessions

test('changing your password signs out your other sessions', async () => {
  const u = await signup(app, 'Session User');
  const other = await login(u.user.email);
  const current = await login(u.user.email);
  const res = await app.inject({
    method: 'PUT',
    url: '/api/v1/me',
    cookies: { tracker_session: current },
    headers: { origin: 'http://tracker.test' },
    payload: { current_password: 'password123', new_password: 'new-password-456' },
  });
  assert.equal(res.statusCode, 200);
  const stillIn = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { tracker_session: current } });
  assert.equal(stillIn.statusCode, 200, 'the session that changed the password stays signed in');
  const kicked = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { tracker_session: other } });
  assert.equal(kicked.statusCode, 401, 'other sessions are revoked');
});

test('repeated failed logins are throttled', async () => {
  const u = await signup(app, 'Throttle User');
  let last = 0;
  for (let i = 0; i < 12; i++) {
    last = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.user.email, password: 'wrong-password' } })).statusCode;
  }
  assert.equal(last, 429);
});

test('viewers cannot modify other members (role or color)', async () => {
  const v = await signup(app, 'Viewer Color');
  await owner.post(`/projects/${pid}/memberships`, { email: v.user.email, role: 'viewer' });
  const ms = await owner.get(`/projects/${pid}/memberships`);
  const ownerM = ms.find((m: any) => m.person.id === owner.user.id);
  const mine = ms.find((m: any) => m.person.id === v.user.id);
  assert.equal((await v.req('PUT', `/projects/${pid}/memberships/${ownerM.id}`, { project_color: '#000000' })).status, 403);
  assert.equal((await v.req('PUT', `/projects/${pid}/memberships/${mine.id}`, { project_color: '#000000' })).status, 200);
  assert.equal((await v.req('PUT', `/projects/${pid}/memberships/${mine.id}`, { role: 'owner' })).status, 403);
});

test('live event streams are capped per user', async () => {
  const u = await signup(app, 'Stream User');
  const cap = app.ctx.config.maxStreamsPerUser;
  // Simulate the cap being reached (opening real streams would hold sockets open).
  for (let i = 0; i < cap; i++) app.ctx.streams.open(u.user.id, () => {});
  const r = await u.req('GET', '/events');
  assert.equal(r.status, 429);
});
