/** Search query language: every filter in the registry, negation, alternatives, and extension. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, type Client } from './helpers.js';
import { registerSearchFilter, searchFilterKeys } from '../src/services/search.js';

let app: Awaited<ReturnType<typeof testApp>>;
let a: Client;
let b: Client;
let pid: number;
const id: Record<string, number> = {};

before(async () => {
  app = await testApp();
  a = await signup(app, 'Ada Lovelace');
  b = await signup(app, 'Bob Builder');
  pid = (await a.post('/projects', { name: 'Search' })).id;
  await a.post(`/projects/${pid}/memberships`, { email: b.user.email });
  await a.post(`/projects/${pid}/epics`, { name: 'Checkout' });
  const mk = async (key: string, body: any, as: Client = a) => (id[key] = (await as.post(`/projects/${pid}/stories`, body)).id);
  await mk('started', { name: 'Card form', estimate: 3, current_state: 'started', owner_ids: [b.user.id], labels: ['checkout', 'ui'] });
  await mk('unestimated', { name: 'Coupons', current_state: 'unstarted', labels: ['checkout'], description: 'Support promo codes' });
  await mk('bug', { name: 'Total rounding', story_type: 'bug', current_state: 'unstarted', tasks: [{ description: 'reproduce' }] }, b);
  await mk('chore', { name: 'Bump deps', story_type: 'chore' });
  await mk('accepted', { name: 'Old thing', estimate: 1, current_state: 'accepted', accepted_at: '2026-01-15T10:00:00Z' });
  await mk('release', { name: 'v2', story_type: 'release', current_state: 'unstarted', deadline: '2030-01-01' });
  await a.post(`/projects/${pid}/stories/${id.bug}/blockers`, { description: `needs #${id.started}` });
  await b.post(`/projects/${pid}/stories/${id.chore}/comments`, { text: 'see attached logs' });
  const types = await a.get(`/projects/${pid}/review_types`);
  await a.post(`/projects/${pid}/stories/${id.started}/reviews`, { review_type_id: types[0].id, reviewer_id: a.user.id });
  await b.post(`/projects/${pid}/stories/${id.unestimated}/follow`);
});
after(async () => app.cleanup());

const search = async (q: string, as: Client = a) => (await as.get(`/projects/${pid}/search?query=${encodeURIComponent(q)}`)).stories.map((s: any) => s.id).sort();
const ids = (...keys: string[]) => keys.map((k) => id[k]).sort();

test('text, phrases and negation', async () => {
  assert.deepEqual(await search('promo'), ids('unestimated'), 'description');
  assert.deepEqual(await search('logs'), ids('chore'), 'comment text');
  assert.deepEqual(await search('reproduce'), ids('bug'), 'task text');
  assert.deepEqual(await search('"card form"'), ids('started'));
  assert.deepEqual(await search('label:checkout -coupons'), ids('started'));
});

test('people filters resolve me, usernames, initials and first names', async () => {
  assert.deepEqual(await search(`owner:${b.user.username}`), ids('started'));
  assert.deepEqual(await search('owner:BB'), ids('started'));
  assert.deepEqual(await search('owner:bob'), ids('started'));
  assert.deepEqual(await search('owner:me', b), ids('started'));
  assert.deepEqual(await search('mywork:me', b), ids('started'));
  assert.deepEqual(await search('requester:me', b), ids('bug'));
  assert.deepEqual(await search('follower:me', b), ids('bug', 'chore', 'started', 'unestimated')); // creator, commenter, owner, explicit follow
  assert.deepEqual(await search('reviewer:me'), ids('started'));
});

test('structural filters', async () => {
  assert.deepEqual(await search('type:bug,chore'), ids('bug', 'chore'));
  assert.deepEqual(await search('state:started'), ids('started'));
  assert.deepEqual(await search('state:done'), ids('accepted'));
  assert.deepEqual(await search(`id:${id.bug},#${id.chore}`), ids('bug', 'chore'));
  assert.deepEqual(await search('estimate:3'), ids('started'));
  assert.deepEqual(await search('estimate:none type:feature'), ids('unestimated'));
  assert.deepEqual(await search('epic:checkout'), ids('started', 'unestimated'));
  assert.deepEqual(await search('label:ui,checkout -label:ui'), ids('unestimated'));
  assert.deepEqual(await search('name:rounding'), ids('bug'));
  assert.deepEqual(await search('description:promo'), ids('unestimated'));
});

test('is: and has: filters', async () => {
  assert.deepEqual(await search('is:blocked'), ids('bug'));
  assert.deepEqual(await search('is:blocking'), ids('started'));
  assert.deepEqual(await search('is:unestimated'), ids('unestimated'));
  assert.deepEqual(await search('has:tasks'), ids('bug'));
  assert.deepEqual(await search('has:comment'), ids('chore'));
  assert.deepEqual(await search('has:review'), ids('started'));
  assert.deepEqual(await search('has:deadline'), ids('release'));
  assert.deepEqual(await search('-has:label type:feature'), []);
});

test('accepted stories are hidden unless asked for', async () => {
  assert.ok(!(await search('thing')).includes(id.accepted));
  assert.deepEqual(await search('thing includedone:true'), ids('accepted'));
  assert.deepEqual(await search('accepted_since:2026-01-01 accepted_before:2026-02-01'), ids('accepted'));
  assert.deepEqual(await search('created_before:2000-01-01'), []);
});

test('invalid filter values are reported, unknown keys are treated as text', async () => {
  const r = await a.req('GET', `/projects/${pid}/search?query=${encodeURIComponent('has:nonsense')}`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Use one of/);
  assert.deepEqual(await search('color:blue'), []);
});

test('filters can be registered as an extension point', async () => {
  assert.ok(!searchFilterKeys().includes('points_over'));
  registerSearchFilter('points_over', (vals) => (s) => (s.estimate ?? 0) > Number(vals[0]));
  assert.deepEqual(await search('points_over:2'), ids('started'));
  assert.throws(() => registerSearchFilter('Bad-Key', () => () => true));
});
