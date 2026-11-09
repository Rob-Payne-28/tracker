/**
 * Authorization matrix generated from the OpenAPI document.
 *
 * Every documented operation is called as (a) an anonymous client, (b) a signed-in user who is not a
 * member of the project, and (c) a project viewer, with a minimal *valid* request body synthesised from
 * the operation's schema (so requests get past validation and actually reach the authorization checks).
 *
 * Because the operation list comes from the spec, a newly added route is covered automatically: if it
 * forgets an access check, this test fails.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, type Client } from './helpers.js';

let app: Awaited<ReturnType<typeof testApp>>;
let spec: any;
let owner: Client;
let viewer: Client;
let outsider: Client;
const ids: Record<string, number> = {};

before(async () => {
  app = await testApp();
  spec = JSON.parse((await app.inject({ method: 'GET', url: '/api/openapi.json' })).body);
  owner = await signup(app, 'Owner Person'); // first user = instance admin
  viewer = await signup(app, 'Viewer Person');
  outsider = await signup(app, 'Outsider Person');

  const p = await owner.post('/projects', { name: 'Private' });
  ids.project_id = p.id;
  await owner.post(`/projects/${p.id}/memberships`, { email: viewer.user.email, role: 'viewer' });
  const s = await owner.post(`/projects/${p.id}/stories`, { name: 'S', estimate: 1, current_state: 'unstarted' });
  ids.story_id = s.id;
  ids.task_id = (await owner.post(`/projects/${p.id}/stories/${s.id}/tasks`, { description: 't' })).id;
  ids.comment_id = (await owner.post(`/projects/${p.id}/stories/${s.id}/comments`, { text: 'c' })).id;
  ids.blocker_id = (await owner.post(`/projects/${p.id}/stories/${s.id}/blockers`, { description: 'b' })).id;
  const types = await owner.get(`/projects/${p.id}/review_types`);
  ids.review_type_id = types[0].id;
  ids.review_id = (await owner.post(`/projects/${p.id}/stories/${s.id}/reviews`, { review_type_id: types[0].id })).id;
  ids.label_id = (await owner.post(`/projects/${p.id}/labels`, { name: 'l' })).id;
  const epic = await owner.post(`/projects/${p.id}/epics`, { name: 'E' });
  ids.epic_id = epic.id;
  ids.epic_comment_id = (await owner.post(`/projects/${p.id}/epics/${epic.id}/comments`, { text: 'ec' })).id;
  ids.webhook_id = (await owner.post(`/projects/${p.id}/webhooks`, { url: 'https://example.com/hook', enabled: false })).id;
  const ms = await owner.get(`/projects/${p.id}/memberships`);
  ids.membership_id = ms.find((m: any) => m.person.id === owner.user.id).id;
  ids.number = 1;
  await owner.put(`/projects/${p.id}/iteration_overrides/1`, { team_strength: 1 });
  const boundary = 'b';
  const up = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${p.id}/uploads`,
    headers: { 'x-trackertoken': owner.token, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--${boundary}--\r\n`,
  });
  ids.upload_id = JSON.parse(up.body).id;
  ids.workspace_id = (await owner.post('/my/workspaces', { name: 'W', project_ids: [p.id] })).id;
  ids.user_id = owner.user.id;
  // A notification for the owner (someone mentions them)
  await owner.put(`/projects/${p.id}/memberships/${ms.find((m: any) => m.person.id === viewer.user.id).id}`, { role: 'member' });
  await viewer.post(`/projects/${p.id}/stories/${s.id}/comments`, { text: `@${owner.user.username}` });
  await owner.put(`/projects/${p.id}/memberships/${ms.find((m: any) => m.person.id === viewer.user.id).id}`, { role: 'viewer' });
  ids.notification_id = (await owner.get('/my/notifications'))[0].id;
});

after(async () => {
  await app.cleanup();
});

/** Fill in path parameters. `id` and `comment_id` are ambiguous, so they depend on the route. */
function fillPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (name === 'id') {
      if (path.startsWith('/api/v1/attachments') || path.includes('/uploads/')) return String(ids.upload_id);
      if (path.startsWith('/api/v1/my/notifications')) return String(ids.notification_id);
      if (path.startsWith('/api/v1/my/workspaces')) return String(ids.workspace_id);
      if (path.startsWith('/api/v1/admin/users')) return String(ids.user_id);
    }
    if (name === 'comment_id' && path.includes('/epics/')) return String(ids.epic_comment_id);
    if (name === 'token') return 'not-a-real-token';
    if (!(name in ids)) throw new Error(`No fixture id for path parameter {${name}} in ${path}`);
    return String(ids[name]);
  });
}

function resolve(schema: any): any {
  if (schema?.$ref) return resolve(spec.components.schemas[schema.$ref.split('/').pop()]);
  return schema;
}

/** Build a minimal value satisfying a JSON schema (required properties only). */
function example(schemaIn: any, key = ''): any {
  const schema = resolve(schemaIn);
  if (!schema) return undefined;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf) {
    const opts = (schema.anyOf ?? schema.oneOf).map(resolve);
    return example(opts.find((o: any) => o.type !== 'null') ?? opts[0], key);
  }
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s: any) => example(s, key)));
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const req of schema.required ?? []) out[req] = example(schema.properties[req], req);
      return out;
    }
    case 'array':
      return schema.minItems ? [example(schema.items, key)] : [];
    case 'integer':
    case 'number':
      if (key.endsWith('_id') || key === 'story_ids') return ids[key] ?? ids.story_id;
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    case 'string':
      if (key === 'url') return 'https://example.com/hook';
      if (key === 'email') return 'someone@example.com';
      if (key === 'password' || key === 'new_password') return 'password123';
      if (schema.pattern?.startsWith('^#')) return '#123456';
      if (schema.pattern?.includes('\\d{4}')) return '2026-01-01';
      return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
    default:
      return undefined;
  }
}

interface Op {
  method: string;
  path: string;
  public: boolean;
  tags: string[];
  body: unknown;
}

function operations(): Op[] {
  const ops: Op[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    if (!path.startsWith('/api/v1')) continue;
    for (const [method, op] of Object.entries<any>(item)) {
      const schema = op.requestBody?.content?.['application/json']?.schema;
      const query = (op.parameters ?? [])
        .filter((prm: any) => prm.in === 'query' && prm.required)
        .map((prm: any) => `${encodeURIComponent(prm.name)}=${encodeURIComponent(String(example(prm.schema, prm.name)))}`)
        .join('&');
      ops.push({
        method: method.toUpperCase(),
        path: path + (query ? `?${query}` : ''),
        public: Array.isArray(op.security) && op.security.length === 0,
        tags: op.tags ?? [],
        body: schema ? example(schema) : undefined,
      });
    }
  }
  return ops;
}

const SAFE = new Set(['GET', 'HEAD']);
/** Operations a signed-in user may legitimately perform without any project membership. */
const isUserScoped = (op: Op) =>
  /^\/api\/v1\/(me|my\/|projects$|source_commits|integrations\/|events|instance|auth\/)/.test(op.path);
const isProjectScoped = (op: Op) => /\{project_id\}|\/stories\/\{story_id\}|\/attachments\//.test(op.path);
/** Mutations a viewer may perform. */
const VIEWER_MAY = [/^POST \/api\/v1\/projects\/\{project_id\}\/stories\/\{story_id\}\/follow$/, /^DELETE \/api\/v1\/projects\/\{project_id\}\/stories\/\{story_id\}\/follow$/];

async function call(op: Op, client: Client | null) {
  const url = fillPath(op.path);
  const res = await app.inject({
    method: op.method as any,
    url,
    ...(op.body !== undefined ? { payload: op.body as any } : {}),
    headers: client ? { 'x-trackertoken': client.token } : {},
  });
  return res.statusCode;
}

test('every documented operation is covered by this matrix', () => {
  const ops = operations();
  assert.ok(ops.length > 60, `expected the full API, found ${ops.length} operations`);
  for (const op of ops) assert.doesNotThrow(() => fillPath(op.path), `${op.method} ${op.path}`);
});

test('anonymous clients cannot reach any non-public operation on a private project', async () => {
  const failures: string[] = [];
  for (const op of operations()) {
    if (op.public || op.path === '/api/v1/events') continue;
    const status = await call(op, null);
    if (status < 400) failures.push(`${op.method} ${op.path} → ${status}`);
  }
  assert.deepEqual(failures, []);
});

test('signed-in non-members cannot read or change another project, nor use admin APIs', async () => {
  const failures: string[] = [];
  for (const op of operations()) {
    if (op.public || op.path === '/api/v1/events') continue;
    const admin = op.tags.includes('Administration');
    if (!admin && !isProjectScoped(op)) continue;
    const status = await call(op, outsider);
    if (status < 400) failures.push(`${op.method} ${op.path} → ${status}`);
    if (!admin && status === 403) failures.push(`${op.method} ${op.path} → 403 leaks the project's existence (expected 404)`);
  }
  assert.deepEqual(failures, []);
});

test('viewers can read but not change a project', async () => {
  const failures: string[] = [];
  let reachedAuthz = 0;
  for (const op of operations()) {
    if (!isProjectScoped(op) || op.public) continue;
    const status = await call(op, viewer);
    const sig = `${op.method} ${op.path}`;
    if (SAFE.has(op.method)) {
      // Owner-only reads (webhooks, which expose secrets) are the exception.
      const ownerOnly = /\/webhooks/.test(op.path);
      if (ownerOnly ? status < 400 : status >= 400) failures.push(`${sig} → ${status}`);
      continue;
    }
    if (VIEWER_MAY.some((re) => re.test(sig))) continue;
    if (status < 400) failures.push(`${sig} → ${status} (viewer mutated the project)`);
    if (status === 403) reachedAuthz++;
  }
  assert.deepEqual(failures, []);
  // Guard against the matrix silently degrading into validation errors: most mutations must be
  // rejected by the authorization layer itself.
  assert.ok(reachedAuthz > 40, `only ${reachedAuthz} viewer mutations reached the authorization check`);
});

test('the private project data is unchanged after the matrix ran', async () => {
  const s = await owner.get(`/projects/${ids.project_id}/stories/${ids.story_id}`);
  assert.equal(s.name, 'S');
  assert.equal(s.tasks.length, 1);
  assert.equal(s.comments.length, 2);
  assert.equal(s.blockers.length, 1);
});
