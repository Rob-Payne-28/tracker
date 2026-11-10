#!/usr/bin/env node
/**
 * Populate a Tracker instance with a demo project, using only the public REST API.
 *
 *   node scripts/demo-seed.mjs [base-url]
 *
 * On a fresh instance it creates the administrator demo@example.com / password123.
 * Otherwise set TRACKER_TOKEN to an existing user's API token.
 */
const base = (process.argv[2] ?? process.env.TRACKER_URL ?? 'http://localhost:3000').replace(/\/$/, '');
let token = process.env.TRACKER_TOKEN;

async function call(method, path, body, tok = token) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { 'X-TrackerToken': tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const dateAgo = (n) => daysAgo(n).slice(0, 10);

if (!token) {
  const instance = await call('GET', '/instance');
  if (!instance.needs_setup) {
    console.error('Instance already has users. Set TRACKER_TOKEN to an API token to seed into it.');
    process.exit(1);
  }
  const me = await call('POST', '/auth/signup', { name: 'Dana Demo', email: 'demo@example.com', password: 'password123' });
  token = me.api_token;
  console.log('Created admin demo@example.com / password123');
}

const people = [];
for (const [name, email] of [
  ['Sam Rivera', 'sam@example.com'],
  ['Priya Shah', 'priya@example.com'],
  ['Lee Chen', 'lee@example.com'],
]) {
  try {
    const admin = await call('POST', '/admin/users', { name, email, password: 'password123' });
    people.push(admin);
  } catch {
    /* not admin or already exists */
  }
}

const project = await call('POST', '/projects', {
  name: 'Orbit Mobile App',
  description: 'Customer-facing mobile app and its API.',
  start_date: dateAgo(7 * 7),
  initial_velocity: 8,
  time_zone: 'UTC',
});
const pid = project.id;
for (const p of people) await call('POST', `/projects/${pid}/memberships`, { person_id: p.id, role: 'member' });
const me = await call('GET', '/me');
const ids = [me.id, ...people.map((p) => p.id)];

await call('POST', `/projects/${pid}/epics`, { name: 'Onboarding', description: 'Get new users to their first success in under 2 minutes.' });
await call('POST', `/projects/${pid}/epics`, { name: 'Payments', description: 'In-app purchases and subscriptions.' });
await call('POST', `/projects/${pid}/epics`, { name: 'Offline mode' });

// History: accepted stories across past iterations so velocity is meaningful.
const done = [
  ['Project skeleton & CI pipeline', 'chore', null, 45],
  ['Sign up with email', 'feature', 3, 44],
  ['Sign in with email', 'feature', 2, 43],
  ['Password reset flow', 'feature', 3, 37],
  ['Crash when rotating on login screen', 'bug', null, 36],
  ['Profile screen', 'feature', 5, 35],
  ['Push notification plumbing', 'feature', 5, 29],
  ['Settings screen', 'feature', 3, 28],
  ['Avatar upload', 'feature', 2, 22],
  ['Onboarding carousel', 'feature', 5, 21],
  ['Fix flaky snapshot tests', 'chore', null, 20],
  ['Dark mode', 'feature', 3, 15],
  ['Subscription plans screen', 'feature', 5, 14],
  ['Typos on paywall', 'bug', null, 13],
  ['App Store screenshots', 'chore', null, 9],
  ['Receipt validation endpoint', 'feature', 3, 8],
  ['Analytics events for funnel', 'feature', 2, 7],
];
for (const [i, [name, type, est, ago]] of done.entries()) {
  await call('POST', `/projects/${pid}/stories`, {
    name,
    story_type: type,
    estimate: est,
    current_state: 'accepted',
    accepted_at: daysAgo(ago),
    owner_ids: [ids[i % ids.length]],
    labels: /sign|password|onboard|profile|avatar/i.test(name) ? ['onboarding'] : /subscri|receipt|paywall/i.test(name) ? ['payments'] : [],
  });
}

// Current work
const mk = (body) => call('POST', `/projects/${pid}/stories`, body);
const a = await mk({ name: 'Checkout with Apple Pay', estimate: 5, current_state: 'started', owner_ids: [ids[1]], labels: ['payments'], description: 'As a subscriber I can pay with **Apple Pay** so that checkout takes one tap.\n\n- Show Apple Pay button when available\n- Fallback to card form', tasks: [{ description: 'Merchant ID & certificates', complete: true }, { description: 'Payment sheet UI' }, { description: 'Server-side token exchange' }] });
await mk({ name: 'Restore purchases', estimate: 2, current_state: 'finished', owner_ids: [ids[2] ?? ids[0]], labels: ['payments'] });
const d = await mk({ name: 'Welcome email after sign up', estimate: 1, current_state: 'delivered', owner_ids: [ids[3] ?? ids[0]], labels: ['onboarding'] });
await mk({ name: 'Tap target too small on close button', story_type: 'bug', current_state: 'rejected', owner_ids: [ids[1]] });
await mk({ name: 'Personalised first-run checklist', estimate: 3, current_state: 'unstarted', labels: ['onboarding'] });
await mk({ name: 'Cache feed for offline reading', estimate: 8, current_state: 'unstarted', labels: ['offline mode'] });
await mk({ name: 'Upgrade React Native to latest', story_type: 'chore', current_state: 'unstarted' });
await mk({ name: 'Queue writes while offline', estimate: 5, current_state: 'unstarted', labels: ['offline mode'] });
await mk({ name: 'Beta release', story_type: 'release', current_state: 'unstarted', deadline: dateAgo(-14) });
await mk({ name: 'Conflict resolution UI', estimate: 3, current_state: 'unstarted', labels: ['offline mode'] });
await mk({ name: 'Family sharing', current_state: 'unstarted', labels: ['payments'] });
await mk({ name: 'Annual plan discount banner', estimate: 1, current_state: 'unstarted', labels: ['payments'] });
// Icebox
await mk({ name: 'Apple Watch companion app', estimate: 8 });
await mk({ name: 'Referral programme' });
await mk({ name: 'Investigate slow cold start on Android', story_type: 'bug' });

await call('POST', `/projects/${pid}/stories/${a.id}/comments`, { text: `Merchant certificates are in the vault. ${people[0] ? '@' + people[0].username + ' can you' : 'Can someone'} review the sheet design?` });
await call('POST', `/projects/${pid}/stories/${a.id}/blockers`, { description: 'Waiting on legal sign-off for EU payment terms' });
const types = await call('GET', `/projects/${pid}/review_types`);
await call('POST', `/projects/${pid}/stories/${a.id}/reviews`, { review_type_id: types.find((t) => t.name === 'Code').id, reviewer_id: ids[2] ?? ids[0] });
await call('POST', `/projects/${pid}/stories/${d.id}/comments`, { text: 'Deployed to staging — template preview attached in the PR.' });

console.log(`Seeded project "${project.name}" → ${base}/projects/${pid}`);
