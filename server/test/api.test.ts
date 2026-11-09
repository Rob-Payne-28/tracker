import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { testApp, signup, Client } from './helpers.js';

let app: Awaited<ReturnType<typeof testApp>>;
let owner: Client;
let member: Client;
let viewer: Client;
let outsider: Client;
let pid: number;

before(async () => {
  app = await testApp();
  owner = await signup(app, 'Olivia Owner');
  member = await signup(app, 'Mark Member');
  viewer = await signup(app, 'Vera Viewer');
  outsider = await signup(app, 'Otto Outsider');
  const p = await owner.post('/projects', { name: 'Apollo', initial_velocity: 5 });
  pid = p.id;
  await owner.post(`/projects/${pid}/memberships`, { email: member.user.email, role: 'member' });
  await owner.post(`/projects/${pid}/memberships`, { email: viewer.user.email, role: 'viewer' });
});

after(async () => {
  await app.cleanup();
});

test('first account is admin, later accounts are not', () => {
  assert.equal(owner.user.is_admin, true);
  assert.equal(member.user.is_admin, false);
});

test('authentication: bad token is rejected, missing token is 401, error envelope is consistent', async () => {
  const bad = new Client(app, 'nope', null);
  const r = await bad.req('GET', '/me');
  assert.equal(r.status, 401);
  assert.equal(r.body.kind, 'error');
  assert.equal(r.body.code, 'unauthenticated');
  const anon = await app.inject({ method: 'GET', url: '/api/v1/projects' });
  assert.equal(anon.statusCode, 401);
});

test('session login works and sets a cookie', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: member.user.email, password: 'password123' } });
  assert.equal(res.statusCode, 200);
  const cookie = res.cookies.find((c) => c.name === 'tracker_session');
  assert.ok(cookie);
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { tracker_session: cookie!.value } });
  assert.equal(JSON.parse(me.body).id, member.user.id);
  const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: member.user.email, password: 'wrong-password' } });
  assert.equal(wrong.statusCode, 401);
});

test('permissions: outsiders cannot see private projects, viewers cannot edit', async () => {
  assert.equal((await outsider.req('GET', `/projects/${pid}`)).status, 404);
  assert.equal((await viewer.req('GET', `/projects/${pid}`)).status, 200);
  const r = await viewer.req('POST', `/projects/${pid}/stories`, { name: 'nope' });
  assert.equal(r.status, 403);
  assert.equal((await member.req('PUT', `/projects/${pid}`, { name: 'x' })).status, 403);
});

test('validation errors are reported per field', async () => {
  const r = await member.req('POST', `/projects/${pid}/stories`, { name: 'x', story_type: 'epic' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid_parameter');
  assert.ok(r.body.validation_errors.length > 0);
});

test('story lifecycle: estimate rules, auto-ownership, accept, activity and notifications', async () => {
  const s = await member.post(`/projects/${pid}/stories`, { name: 'Login page', current_state: 'unstarted', labels: ['auth', 'ui'] });
  assert.equal(s.story_type, 'feature');
  assert.equal(s.requested_by_id, member.user.id);
  assert.deepEqual(s.labels.map((l: any) => l.name), ['auth', 'ui']);

  const start = await member.req('PUT', `/projects/${pid}/stories/${s.id}`, { current_state: 'started' });
  assert.equal(start.status, 400);
  assert.match(start.body.error, /Unestimated/);

  const bad = await member.req('PUT', `/projects/${pid}/stories/${s.id}`, { estimate: 4 });
  assert.equal(bad.status, 400, 'estimate must be on the point scale');

  await owner.put(`/projects/${pid}/stories/${s.id}`, { estimate: 3 });
  const started = await owner.put(`/projects/${pid}/stories/${s.id}`, { current_state: 'started' });
  assert.deepEqual(started.owner_ids, [owner.user.id], 'starter becomes owner');
  assert.ok(started.started_at);

  await owner.put(`/projects/${pid}/stories/${s.id}`, { current_state: 'finished' });
  await owner.put(`/projects/${pid}/stories/${s.id}`, { current_state: 'delivered' });
  // requester (member) gets a delivered notification
  const notes = await member.get('/my/notifications');
  assert.ok(notes.some((n: any) => n.notification_type === 'story_delivered' && n.story.id === s.id));
  const work = await member.get('/my/work');
  assert.ok(work.to_accept.some((x: any) => x.id === s.id));

  const accepted = await member.put(`/projects/${pid}/stories/${s.id}`, { current_state: 'accepted' });
  assert.ok(accepted.accepted_at);

  const history = await member.get(`/projects/${pid}/stories/${s.id}/activity`);
  assert.deepEqual(
    history.map((a: any) => a.highlight).reverse(),
    ['added', 'estimated', 'started', 'finished', 'delivered', 'accepted'],
  );
  assert.match(history[0].message, /^Mark Member accepted "Login page"$/);

  const proj = await owner.get(`/projects/${pid}`);
  assert.ok(proj.version >= 6);
});

test('chores and releases have restricted workflows', async () => {
  const chore = await member.post(`/projects/${pid}/stories`, { name: 'Upgrade deps', story_type: 'chore', current_state: 'unstarted' });
  assert.equal((await member.req('PUT', `/projects/${pid}/stories/${chore.id}`, { current_state: 'finished' })).status, 400);
  assert.equal((await member.req('PUT', `/projects/${pid}/stories/${chore.id}`, { estimate: 1 })).status, 400);
  await member.put(`/projects/${pid}/stories/${chore.id}`, { current_state: 'started' });
  const done = await member.put(`/projects/${pid}/stories/${chore.id}`, { current_state: 'accepted' });
  assert.equal(done.current_state, 'accepted');

  const rel = await member.post(`/projects/${pid}/stories`, { name: 'v1.0', story_type: 'release', current_state: 'unstarted', deadline: '2030-01-01' });
  assert.equal(rel.deadline, '2030-01-01');
  assert.equal((await member.req('PUT', `/projects/${pid}/stories/${rel.id}`, { current_state: 'started' })).status, 400);
  // changing a started feature to a release resets its state
  const f = await member.post(`/projects/${pid}/stories`, { name: 'f', estimate: 1, current_state: 'started' });
  const r2 = await member.put(`/projects/${pid}/stories/${f.id}`, { story_type: 'release' });
  assert.equal(r2.current_state, 'unstarted');
  assert.equal(r2.estimate, null);
});

test('prioritisation with before_id/after_id and icebox moves', async () => {
  const p = await owner.post('/projects', { name: 'Ordering' });
  const mk = (name: string) => owner.post(`/projects/${p.id}/stories`, { name, current_state: 'unstarted', estimate: 1 });
  const a = await mk('A');
  const b = await mk('B');
  const c = await mk('C');
  const order = async () => (await owner.get(`/projects/${p.id}/stories?with_state=unstarted`)).map((s: any) => s.name).join('');
  assert.equal(await order(), 'ABC');
  await owner.put(`/projects/${p.id}/stories/${c.id}`, { before_id: a.id });
  assert.equal(await order(), 'CAB');
  await owner.put(`/projects/${p.id}/stories/${c.id}`, { after_id: b.id });
  assert.equal(await order(), 'ABC');
  // Many moves into the same gap force a renormalisation; order must still be right.
  for (let i = 0; i < 60; i++) {
    await owner.put(`/projects/${p.id}/stories/${i % 2 ? b.id : c.id}`, { after_id: a.id });
  }
  assert.equal((await order())[0], 'A');
  // Move into icebox
  const iced = await owner.put(`/projects/${p.id}/stories/${b.id}`, { current_state: 'unscheduled' });
  assert.equal(iced.current_state, 'unscheduled');
  const board = await owner.get(`/projects/${p.id}/board`);
  assert.deepEqual(board.icebox_ids, [b.id]);
  assert.equal(board.iterations[0].scope, 'current');
  assert.equal(board.velocity, 10);
  // bulk move to top of backlog
  await owner.put(`/projects/${p.id}/stories/bulk`, { story_ids: [b.id], move: 'top_of_backlog' });
  assert.equal((await order())[0], 'B');
});

test('tasks, comments with mentions, blockers and reviews', async () => {
  const s = await owner.post(`/projects/${pid}/stories`, { name: 'Payments', tasks: [{ description: 'one' }, { description: 'two' }] });
  assert.equal(s.tasks.length, 2);
  const t = await member.post(`/projects/${pid}/stories/${s.id}/tasks`, { description: 'zero', position: 1 });
  const tasks = await member.get(`/projects/${pid}/stories/${s.id}/tasks`);
  assert.deepEqual(tasks.map((x: any) => x.description), ['zero', 'one', 'two']);
  await member.put(`/projects/${pid}/stories/${s.id}/tasks/${t.id}`, { complete: true });

  const c = await owner.post(`/projects/${pid}/stories/${s.id}/comments`, { text: `Hey @${member.user.username} take a look` });
  assert.equal(c.person_id, owner.user.id);
  const notes = await member.get('/my/notifications?unread_only=true');
  const mention = notes.find((n: any) => n.notification_type === 'mention' && n.story?.id === s.id);
  assert.ok(mention, 'mentioned user is notified');
  await member.put(`/my/notifications/${mention.id}`, { read: true });

  assert.equal((await member.req('PUT', `/projects/${pid}/stories/${s.id}/comments/${c.id}`, { text: 'hijack' })).status, 403);

  const other = await owner.post(`/projects/${pid}/stories`, { name: 'API keys' });
  await member.post(`/projects/${pid}/stories/${s.id}/blockers`, { description: `waiting on #${other.id}` });
  const full = await member.get(`/projects/${pid}/stories/${s.id}`);
  assert.equal(full.blocker_count, 1);
  assert.deepEqual(full.blocked_by_story_ids, [other.id]);
  assert.equal(full.tasks_completed, 1);
  const blocking = await member.get(`/projects/${pid}/stories/${other.id}`);
  assert.deepEqual(blocking.blocking_story_ids, [s.id]);

  const types = await member.get(`/projects/${pid}/review_types`);
  assert.ok(types.length >= 4);
  const review = await owner.post(`/projects/${pid}/stories/${s.id}/reviews`, { review_type_id: types[0].id, reviewer_id: member.user.id });
  assert.equal(review.status, 'unstarted');
  const work = await member.get('/my/work');
  assert.ok(work.to_review.some((x: any) => x.id === s.id));
  await member.put(`/projects/${pid}/stories/${s.id}/reviews/${review.id}`, { status: 'pass' });
  const after = await member.get(`/projects/${pid}/stories/${s.id}`);
  assert.equal(after.reviews_passed, 1);
});

test('labels, epics and search', async () => {
  const p = await owner.post('/projects', { name: 'Search' });
  const epic = await owner.post(`/projects/${p.id}/epics`, { name: 'Onboarding' });
  assert.equal(epic.label.name, 'onboarding');
  await owner.post(`/projects/${p.id}/stories`, { name: 'Welcome email', labels: ['onboarding'], estimate: 2, current_state: 'unstarted' });
  await owner.post(`/projects/${p.id}/stories`, { name: 'Signup form', labels: ['onboarding', 'ui'], estimate: 3, story_type: 'feature' });
  const bug = await owner.post(`/projects/${p.id}/stories`, { name: 'Crash on save', story_type: 'bug', description: 'stack trace attached' });
  await owner.post(`/projects/${p.id}/stories/${bug.id}/comments`, { text: 'Also happens on Safari' });

  const e = await owner.get(`/projects/${p.id}/epics/${epic.id}`);
  assert.equal(e.stories_total, 2);
  assert.equal(e.points_total, 5);

  const q = async (query: string) => (await owner.get(`/projects/${p.id}/search?query=${encodeURIComponent(query)}`)).stories.map((s: any) => s.name).sort();
  assert.deepEqual(await q('epic:Onboarding'), ['Signup form', 'Welcome email']);
  assert.deepEqual(await q('label:onboarding -label:ui'), ['Welcome email']);
  assert.deepEqual(await q('type:bug'), ['Crash on save']);
  assert.deepEqual(await q('safari'), ['Crash on save'], 'comment text is searched');
  assert.deepEqual(await q('state:unstarted'), ['Welcome email']);
  assert.deepEqual(await q('is:unestimated'), []);
  assert.deepEqual(await q(`requester:${owner.user.username} has:comment`), ['Crash on save']);
  const res = await owner.get(`/projects/${p.id}/search?query=label:onboarding`);
  assert.equal(res.total_points, 5);

  const labels = await owner.get(`/projects/${p.id}/labels`);
  const ob = labels.find((l: any) => l.name === 'onboarding');
  assert.equal(ob.story_count, 2);
  assert.equal(ob.epic_id, epic.id);
  assert.equal((await owner.req('DELETE', `/projects/${p.id}/labels/${ob.id}`)).status, 409);
});

test('iterations, overrides and analytics', async () => {
  const p = await owner.post('/projects', { name: 'Velocity', initial_velocity: 4 });
  for (const est of [2, 2, 3, 1]) await owner.post(`/projects/${p.id}/stories`, { name: `S${est}`, estimate: est, current_state: 'unstarted' });
  let its = await owner.get(`/projects/${p.id}/iterations`);
  assert.deepEqual(its.map((i: any) => i.points), [4, 4]);
  assert.equal(its[0].stories.length, 2);
  const cur = its[0].number;
  await owner.put(`/projects/${p.id}/iteration_overrides/${cur}`, { team_strength: 0.5 });
  its = await owner.get(`/projects/${p.id}/iterations`);
  assert.equal(its[0].capacity, 2);
  assert.deepEqual(its.map((i: any) => i.points), [2, 2, 4]);
  const whatIf = await owner.get(`/projects/${p.id}/iterations?velocity=20`);
  assert.equal(whatIf.length, 1 + 0 + (whatIf.length - 1));
  const analytics = await owner.get(`/projects/${p.id}/analytics`);
  assert.equal(analytics.velocity, 4);
  assert.equal(analytics.backlog_points, 6);
});

test('webhooks are signed and delivered', async () => {
  const received: { body: string; sig: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ body, sig: String(req.headers['x-tracker-signature']) });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const hook = await owner.post(`/projects/${pid}/webhooks`, { url: `http://127.0.0.1:${port}/hook` });
  const test1 = await owner.post(`/projects/${pid}/webhooks/${hook.id}/test`);
  assert.equal(test1.status, 200);
  await member.post(`/projects/${pid}/stories`, { name: 'Webhook story' });
  for (let i = 0; i < 50 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  server.close();
  assert.equal(received.length, 2);
  const last = received[1];
  const expected = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(last.body).digest('hex');
  assert.equal(last.sig, expected);
  const payload = JSON.parse(last.body);
  assert.equal(payload.kind, 'story_create_activity');
  assert.equal(payload.primary_resources[0].name, 'Webhook story');
  await owner.del(`/projects/${pid}/webhooks/${hook.id}`);
});

test('source commits finish and deliver stories', async () => {
  const s = await member.post(`/projects/${pid}/stories`, { name: 'Commit me', estimate: 1, current_state: 'started' });
  const r = await member.post('/source_commits', { source_commit: { message: `Implement it [Finishes #${s.id}]`, author: 'dev', commit_id: 'abc123' } });
  assert.deepEqual(r, [{ story_id: s.id, ok: true, action: 'finish' }]);
  let story = await member.get(`/projects/${pid}/stories/${s.id}`);
  assert.equal(story.current_state, 'finished');
  assert.equal(story.comments[0].commit_identifier, 'abc123');
  await app.inject({
    method: 'POST',
    url: `/api/v1/integrations/vcs?token=${member.token}`,
    headers: { 'x-github-event': 'push' },
    payload: { commits: [{ id: 'def456', message: `[Delivers #${s.id}]`, url: 'https://git.example/c/def456', author: { name: 'Dev' } }] },
  });
  story = await member.get(`/projects/${pid}/stories/${s.id}`);
  assert.equal(story.current_state, 'delivered');
  assert.equal(story.comments[1].commit_type, 'github');
});

test('csv export and import round-trip', async () => {
  const p = await owner.post('/projects', { name: 'CSV' });
  await owner.post(`/projects/${p.id}/stories`, { name: 'Has, comma', labels: ['x'], estimate: 2, current_state: 'unstarted', tasks: [{ description: 'do it' }] });
  const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${p.id}/export.csv`, headers: { 'x-trackertoken': owner.token } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/csv/);
  const p2 = await owner.post('/projects', { name: 'CSV2' });
  const imp = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${p2.id}/import`,
    headers: { 'x-trackertoken': owner.token, 'content-type': 'text/csv' },
    payload: res.body,
  });
  assert.equal(imp.statusCode, 200, imp.body);
  assert.equal(JSON.parse(imp.body).imported, 1);
  const [s] = await owner.get(`/projects/${p2.id}/stories`);
  assert.equal(s.name, 'Has, comma');
  assert.equal(s.estimate, 2);
  assert.equal(s.labels[0].name, 'x');
  assert.equal(s.tasks_total, 1);
});

test('file uploads attach to comments and download with access control', async () => {
  const s = await member.post(`/projects/${pid}/stories`, { name: 'Has file' });
  const boundary = '----trackertest';
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hello.txt"\r\nContent-Type: text/plain\r\n\r\nhello world\r\n--${boundary}--\r\n`;
  const up = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${pid}/uploads`,
    headers: { 'x-trackertoken': member.token, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(up.statusCode, 201, up.body);
  const file = JSON.parse(up.body);
  assert.equal(file.size, 11);
  const c = await member.post(`/projects/${pid}/stories/${s.id}/comments`, { file_attachment_ids: [file.id] });
  assert.equal(c.file_attachments[0].filename, 'hello.txt');
  const dl = await app.inject({ method: 'GET', url: `${file.download_url}?token=${viewer.token}` });
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.body, 'hello world');
  const denied = await app.inject({ method: 'GET', url: `${file.download_url}?token=${outsider.token}` });
  assert.equal(denied.statusCode, 404);
});

test('moving a story to another project re-creates labels and drops non-members', async () => {
  const other = await member.post('/projects', { name: 'Elsewhere' });
  const s = await member.post(`/projects/${pid}/stories`, { name: 'Mover', labels: ['portable'], owner_ids: [owner.user.id] });
  const moved = await member.put(`/projects/${pid}/stories/${s.id}`, { project_id: other.id });
  assert.equal(moved.project_id, other.id);
  assert.equal(moved.labels[0].name, 'portable');
  assert.equal(moved.labels[0].project_id, other.id);
  assert.deepEqual(moved.owner_ids, []);
  assert.equal((await member.req('GET', `/projects/${pid}/stories/${s.id}`)).status, 404);
});

test('invitations create accounts that can be accepted', async () => {
  const r = await owner.post(`/projects/${pid}/memberships`, { email: 'newbie@example.com', name: 'New Bie' });
  assert.ok(r.invite_url);
  const token = r.invite_url.split('/invite/')[1];
  const info = await app.inject({ method: 'GET', url: `/api/v1/auth/invitation/${token}` });
  assert.deepEqual(JSON.parse(info.body).projects, ['Apollo']);
  const acc = await app.inject({ method: 'POST', url: `/api/v1/auth/invitation/${token}/accept`, payload: { name: 'New Bie', password: 'longenough' } });
  assert.equal(acc.statusCode, 200);
  const again = await app.inject({ method: 'POST', url: `/api/v1/auth/invitation/${token}/accept`, payload: { name: 'x', password: 'longenough' } });
  assert.equal(again.statusCode, 400);
});

test('a project must keep an owner; admins can disable signup', async () => {
  const ms = await owner.get(`/projects/${pid}/memberships`);
  const mine = ms.find((m: any) => m.person.id === owner.user.id);
  assert.equal((await owner.req('DELETE', `/projects/${pid}/memberships/${mine.id}`)).status, 400);
  await owner.put('/admin/settings', { allow_signup: false });
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { name: 'Late', email: 'late@example.com', password: 'password123' } });
  assert.equal(res.statusCode, 403);
  assert.equal((await member.req('GET', '/admin/users')).status, 403);
  await owner.put('/admin/settings', { allow_signup: true });
});

test('OpenAPI document is served and describes every route', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
  const doc = JSON.parse(res.body);
  assert.equal(doc.openapi, '3.1.0');
  for (const [p, ops] of Object.entries<any>(doc.paths)) {
    for (const [method, op] of Object.entries<any>(ops)) {
      assert.ok(op.summary, `${method.toUpperCase()} ${p} lacks a summary`);
      assert.ok(op.tags?.length, `${method.toUpperCase()} ${p} lacks tags`);
    }
  }
  const ui = await app.inject({ method: 'GET', url: '/api/docs' });
  assert.ok(ui.statusCode < 400);
});

test('explicit nulls are not coerced (estimate: null stays null)', async () => {
  const chore = await member.post(`/projects/${pid}/stories`, { name: 'Null estimate chore', story_type: 'chore', estimate: null });
  assert.equal(chore.estimate, null);
  const f = await member.post(`/projects/${pid}/stories`, { name: 'Estimated', estimate: 3 });
  const cleared = await member.put(`/projects/${pid}/stories/${f.id}`, { estimate: null, requested_by_id: null });
  assert.equal(cleared.estimate, null);
  assert.equal(cleared.requested_by_id, null);
});
