import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { requireUser } from '../app.js';
import { ref, Ok, ProjectCreate, ProjectUpdate, ProjectParams, RoleEnum, Nullable } from '../schemas.js';
import { access, getProject, membershipsFor, projectJson, type Project, type Role } from '../services/projects.js';
import { recordActivity } from '../services/activity.js';
import { deliverOne } from '../services/webhooks.js';
import { assertSafeWebhookUrl } from '../lib/net.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { alignToWeekday, isValidDate, isValidTimeZone, localDate, type Weekday } from '../lib/dates.js';
import { now, type Row } from '../db/index.js';
import { randomToken, sha256 } from '../lib/auth.js';
import { createUser } from './auth.js';
import { commentsJson, findOrCreateLabel } from '../services/stories.js';
import type { Ctx } from '../services/context.js';

const POINT_SCALES: Record<string, string> = { fibonacci: '0,1,2,3,5,8', linear: '0,1,2,3', powers_of_two: '0,1,2,4,8' };
const DEFAULT_REVIEW_TYPES = ['Test (QA)', 'Design', 'Code', 'Security'];
const COLORS = ['#2b6cb0', '#2f855a', '#c05621', '#6b46c1', '#b83280', '#2c7a7b', '#975a16', '#c53030'];

/** Columns a project owner may change. Anything else in a request body is ignored. */
const UPDATABLE_PROJECT_FIELDS = [
  'name', 'description', 'iteration_length', 'week_start_day', 'point_scale', 'initial_velocity', 'velocity_averaged_over',
  'bugs_and_chores_are_estimatable', 'automatic_planning', 'enable_tasks', 'public', 'archived', 'start_date', 'time_zone',
] as const;

function pick<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): Partial<T> {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]])) as Partial<T>;
}

export function normalizePointScale(v: string): string {
  const preset = POINT_SCALES[v.trim().toLowerCase()];
  if (preset) return preset;
  const nums = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (!nums.length || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1000)) {
    throw badRequest('point_scale must be "fibonacci", "linear", "powers_of_two", or comma separated non-negative numbers.');
  }
  return [...new Set(nums)].sort((a, b) => a - b).join(',');
}

function validateProjectFields(b: any) {
  if (b.point_scale !== undefined) b.point_scale = normalizePointScale(b.point_scale);
  if (b.time_zone !== undefined && !isValidTimeZone(b.time_zone)) throw badRequest(`Unknown time zone "${b.time_zone}".`);
  if (b.start_date !== undefined && !isValidDate(b.start_date)) throw badRequest('start_date must be YYYY-MM-DD.');
  const bools = ['bugs_and_chores_are_estimatable', 'automatic_planning', 'enable_tasks', 'public', 'archived'];
  for (const k of bools) if (b[k] !== undefined) b[k] = b[k] ? 1 : 0;
  return b;
}

export function epicJson(ctx: Ctx, e: Row, withComments = false) {
  const stats = ctx.db.get(
    `SELECT COUNT(*) AS total,
            SUM(s.current_state = 'accepted') AS accepted,
            SUM(CASE WHEN s.story_type = 'feature' OR (p.bugs_and_chores_are_estimatable AND s.story_type IN ('bug','chore')) THEN COALESCE(s.estimate, 0) ELSE 0 END) AS pts,
            SUM(CASE WHEN s.current_state = 'accepted' AND (s.story_type = 'feature' OR (p.bugs_and_chores_are_estimatable AND s.story_type IN ('bug','chore'))) THEN COALESCE(s.estimate, 0) ELSE 0 END) AS pts_done
       FROM story_labels sl JOIN stories s ON s.id = sl.story_id JOIN projects p ON p.id = s.project_id
      WHERE sl.label_id = ?`,
    [e.label_id],
  )!;
  const states: Record<string, number> = {};
  for (const r of ctx.db.all(
    'SELECT s.current_state, COUNT(*) AS n FROM story_labels sl JOIN stories s ON s.id = sl.story_id WHERE sl.label_id = ? GROUP BY s.current_state',
    [e.label_id],
  ))
    states[r.current_state] = r.n;
  const label = ctx.db.get('SELECT id, project_id, name FROM labels WHERE id = ?', [e.label_id])!;
  return {
    kind: 'epic',
    id: e.id as number,
    project_id: e.project_id as number,
    name: e.name as string,
    description: e.description as string,
    label: { kind: 'label', id: label.id as number, project_id: label.project_id as number, name: label.name as string },
    position: e.position as number,
    stories_total: Number(stats.total ?? 0),
    stories_accepted: Number(stats.accepted ?? 0),
    points_total: Number(stats.pts ?? 0),
    points_accepted: Number(stats.pts_done ?? 0),
    state_counts: states,
    ...(withComments ? { comments: commentsJson(ctx, ctx.db.all('SELECT * FROM comments WHERE epic_id = ? ORDER BY id', [e.id])) } : {}),
    url: `${ctx.config.baseUrl}/projects/${e.project_id}/epics/${e.id}`,
    created_at: e.created_at as string,
    updated_at: e.updated_at as string,
  };
}

function webhookJson(w: Row) {
  return {
    kind: 'webhook',
    id: w.id as number,
    project_id: w.project_id as number,
    url: w.url as string,
    secret: w.secret as string,
    enabled: !!w.enabled,
    last_status: (w.last_status as number) ?? null,
    last_error: (w.last_error as string) ?? null,
    last_delivered_at: (w.last_delivered_at as string) ?? null,
    created_at: w.created_at as string,
    updated_at: w.updated_at as string,
  };
}

function reviewTypeJson(r: Row) {
  return {
    kind: 'review_type',
    id: r.id as number,
    project_id: r.project_id as number,
    name: r.name as string,
    hidden: !!r.hidden,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

const proj = (ctx: Ctx, p: Project, role: Role | null) => projectJson(ctx, p, role);

export async function projectRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const db = ctx.db;
  const P = ProjectParams;
  const pid = (req: any) => Number(req.params.project_id);

  // ------------------------------------------------------------------ Projects
  app.get(
    '/projects',
    {
      schema: {
        tags: ['Projects'],
        summary: 'List your projects',
        description: 'Projects you are a member of. Administrators can pass `all=true` to list every project on the instance.',
        querystring: Type.Object({
          include_archived: Type.Optional(Type.Boolean({ default: false })),
          all: Type.Optional(Type.Boolean({ default: false })),
        }),
        response: { 200: Type.Array(ref('Project')) },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const q = req.query as any;
      const rows =
        q.all && u.is_admin
          ? db.all<Project & { role: Role | null }>(
              'SELECT p.*, m.role FROM projects p LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = ? ORDER BY p.name COLLATE NOCASE',
              [u.id],
            )
          : db.all<Project & { role: Role }>(
              'SELECT p.*, m.role FROM projects p JOIN memberships m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.name COLLATE NOCASE',
              [u.id],
            );
      return rows.filter((p) => q.include_archived || !p.archived).map((p) => proj(ctx, p, p.role ?? (u.is_admin ? 'owner' : null)));
    },
  );

  app.post(
    '/projects',
    {
      schema: {
        tags: ['Projects'],
        summary: 'Create a project',
        description: 'You become the project owner. Default review types (QA, Design, Code, Security) are created.',
        body: ProjectCreate,
        response: { 201: ref('Project') },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const b = validateProjectFields({ ...(req.body as any) });
      const tz = b.time_zone ?? u.time_zone ?? 'UTC';
      const week_start_day = b.week_start_day ?? 'Monday';
      const start = b.start_date ?? alignToWeekday(localDate(new Date(), tz), week_start_day as Weekday);
      const id = ctx.tx(() => {
        const ts = now();
        const id = db.insert('projects', {
          name: b.name.trim(),
          description: b.description ?? '',
          iteration_length: b.iteration_length ?? 1,
          week_start_day,
          point_scale: b.point_scale ?? POINT_SCALES.fibonacci,
          initial_velocity: b.initial_velocity ?? 10,
          velocity_averaged_over: b.velocity_averaged_over ?? 3,
          bugs_and_chores_are_estimatable: b.bugs_and_chores_are_estimatable ?? 0,
          automatic_planning: b.automatic_planning ?? 1,
          enable_tasks: b.enable_tasks ?? 1,
          public: b.public ?? 0,
          archived: 0,
          start_date: start,
          time_zone: tz,
          version: 0,
          created_at: ts,
          updated_at: ts,
        });
        db.insert('memberships', { project_id: id, user_id: u.id, role: 'owner', project_color: COLORS[id % COLORS.length], created_at: ts, updated_at: ts });
        for (const name of DEFAULT_REVIEW_TYPES) db.insert('review_types', { project_id: id, name, hidden: 0, created_at: ts, updated_at: ts });
        recordActivity(ctx, {
          project_id: id,
          performer: u,
          kind: 'project_create_activity',
          highlight: 'created',
          message: `created this project`,
          primary_resources: [{ kind: 'project', id, name: b.name }],
        });
        return id;
      });
      return reply.status(201).send(proj(ctx, getProject(ctx, id), 'owner'));
    },
  );

  app.get(
    '/projects/:project_id',
    { schema: { tags: ['Projects'], summary: 'Get a project', params: P, response: { 200: ref('Project') } } },
    async (req) => {
      const a = access(ctx, pid(req), req.user, 'viewer');
      return proj(ctx, a.project, a.role);
    },
  );

  app.put(
    '/projects/:project_id',
    {
      schema: {
        tags: ['Projects'],
        summary: 'Update project settings',
        description: 'Owner only. Changing iteration settings re-plans the backlog immediately.',
        params: P,
        body: ProjectUpdate,
        response: { 200: ref('Project') },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'owner');
      const b = validateProjectFields(pick(req.body as any, UPDATABLE_PROJECT_FIELDS));
      if (b.name !== undefined) b.name = b.name.trim();
      ctx.tx(() => {
        const before = a.project as any;
        const changed: Record<string, unknown> = {};
        const orig: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(b)) {
          if (before[k] !== v) {
            changed[k] = v;
            orig[k] = before[k];
          }
        }
        if (!Object.keys(changed).length) return;
        db.update('projects', a.project.id, { ...(changed as any), updated_at: now() });
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'project_update_activity',
          highlight: 'changed',
          message: `changed project settings (${Object.keys(changed).join(', ')})`,
          changes: [{ kind: 'project', change_type: 'update', id: a.project.id, original_values: orig, new_values: changed }],
          primary_resources: [{ kind: 'project', id: a.project.id, name: a.project.name }],
        });
      });
      return proj(ctx, getProject(ctx, a.project.id), a.role);
    },
  );

  app.delete(
    '/projects/:project_id',
    {
      schema: {
        tags: ['Projects'],
        summary: 'Delete a project',
        description: 'Owner only. Permanently deletes the project and all of its stories. Consider archiving instead.',
        params: P,
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const a = access(ctx, pid(req), requireUser(req), 'owner');
      db.run('DELETE FROM projects WHERE id = ?', [a.project.id]);
      ctx.events.publish(`project:${a.project.id}`, { type: 'project', project_id: a.project.id, data: { deleted: true } });
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ Memberships
  const MembershipWithInvite = Type.Intersect([ref('Membership'), Type.Object({ invite_url: Type.Optional(Type.String()) })]);

  app.get(
    '/projects/:project_id/memberships',
    { schema: { tags: ['Members'], summary: 'List project members', params: P, response: { 200: Type.Array(ref('Membership')) } } },
    async (req) => {
      access(ctx, pid(req), req.user, 'viewer');
      return membershipsFor(ctx, pid(req));
    },
  );

  app.post(
    '/projects/:project_id/memberships',
    {
      schema: {
        tags: ['Members'],
        summary: 'Add a member',
        description:
          'Owner only. Identify the person by `person_id`, `email` or `username`. If no account exists for the email, an invited account is created and the response includes an `invite_url` to share with them (it is also emailed when SMTP is configured).',
        params: P,
        body: Type.Object({
          person_id: Type.Optional(Type.Integer()),
          email: Type.Optional(Type.String()),
          username: Type.Optional(Type.String()),
          name: Type.Optional(Type.String({ description: 'Name for a newly invited account' })),
          role: Type.Optional(RoleEnum),
        }),
        response: { 201: MembershipWithInvite },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'owner');
      const b = req.body as any;
      let invite_url: string | undefined;
      const result = ctx.tx(() => {
        let person: Row | undefined;
        if (b.person_id) person = db.get('SELECT * FROM users WHERE id = ?', [b.person_id]);
        else if (b.username) person = db.get('SELECT * FROM users WHERE username = ?', [b.username]);
        else if (b.email) person = db.get('SELECT * FROM users WHERE email = ?', [b.email.trim().toLowerCase()]);
        else throw badRequest('Provide person_id, email or username.');
        if (!person) {
          if (!b.email) throw notFound('Person');
          const id = createUser(ctx, { name: b.name ?? b.email.split('@')[0], email: b.email });
          const token = randomToken(24);
          db.run('UPDATE users SET invite_token = ? WHERE id = ?', [sha256(token), id]);
          invite_url = `${ctx.config.baseUrl}/invite/${token}`;
          person = db.get('SELECT * FROM users WHERE id = ?', [id]);
          void ctx.mailer.send(
            b.email,
            `${u.name} invited you to "${a.project.name}"`,
            `${u.name} invited you to collaborate on "${a.project.name}".\n\nAccept the invitation:\n${invite_url}`,
          );
        }
        if (db.get('SELECT 1 FROM memberships WHERE project_id = ? AND user_id = ?', [a.project.id, person!.id])) {
          throw conflict(`${person!.name} is already a member.`);
        }
        const ts = now();
        const mid = db.insert('memberships', {
          project_id: a.project.id,
          user_id: person!.id,
          role: b.role ?? 'member',
          project_color: COLORS[a.project.id % COLORS.length],
          created_at: ts,
          updated_at: ts,
        });
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'project_membership_create_activity',
          highlight: 'added',
          message: `added ${person!.name} as ${b.role ?? 'member'}`,
          primary_resources: [{ kind: 'person', id: person!.id, name: person!.name }],
        });
        return mid;
      });
      const m = membershipsFor(ctx, a.project.id).find((m) => m.id === result)!;
      return reply.status(201).send({ ...m, ...(invite_url ? { invite_url } : {}) });
    },
  );

  app.put(
    '/projects/:project_id/memberships/:membership_id',
    {
      schema: {
        tags: ['Members'],
        summary: 'Update a membership',
        description: 'Owners can change roles. Anyone can change their own project_color.',
        params: Type.Object({ project_id: Type.Integer(), membership_id: Type.Integer() }),
        body: Type.Object({ role: Type.Optional(RoleEnum), project_color: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })) }),
        response: { 200: ref('Membership') },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const { membership_id } = req.params as any;
      const a = access(ctx, pid(req), u, 'viewer');
      const m = db.get('SELECT * FROM memberships WHERE id = ? AND project_id = ?', [membership_id, a.project.id]);
      if (!m) throw notFound('Membership');
      if (m.user_id !== u.id && a.role !== 'owner') throw forbidden('Only project owners can change other members.');
      const b = req.body as any;
      if (b.role !== undefined && b.role !== m.role) {
        if (a.role !== 'owner') throw forbidden('Only project owners can change roles.');
        if (m.role === 'owner' && b.role !== 'owner') ensureAnotherOwner(ctx, a.project.id, m.user_id);
      }
      if (b.project_color !== undefined && m.user_id !== u.id && a.role !== 'owner') throw forbidden();
      ctx.tx(() => {
        db.update('memberships', m.id, { ...(b.role ? { role: b.role } : {}), ...(b.project_color ? { project_color: b.project_color } : {}), updated_at: now() });
        if (b.role && b.role !== m.role) {
          const p = db.get('SELECT name FROM users WHERE id = ?', [m.user_id])!;
          recordActivity(ctx, {
            project_id: a.project.id,
            performer: u,
            kind: 'project_membership_update_activity',
            highlight: 'changed',
            message: `changed ${p.name}'s role to ${b.role}`,
            primary_resources: [{ kind: 'person', id: m.user_id, name: p.name }],
          });
        }
      });
      return membershipsFor(ctx, a.project.id).find((x) => x.id === m.id)!;
    },
  );

  app.delete(
    '/projects/:project_id/memberships/:membership_id',
    {
      schema: {
        tags: ['Members'],
        summary: 'Remove a member',
        description: 'Owners can remove anyone; members can remove themselves (leave). A project must keep at least one owner.',
        params: Type.Object({ project_id: Type.Integer(), membership_id: Type.Integer() }),
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'viewer');
      const m = db.get('SELECT * FROM memberships WHERE id = ? AND project_id = ?', [(req.params as any).membership_id, a.project.id]);
      if (!m) throw notFound('Membership');
      if (m.user_id !== u.id && a.role !== 'owner') throw forbidden('Only project owners can remove members.');
      if (m.role === 'owner') ensureAnotherOwner(ctx, a.project.id, m.user_id);
      ctx.tx(() => {
        db.run('DELETE FROM memberships WHERE id = ?', [m.id]);
        db.run('DELETE FROM story_owners WHERE user_id = ? AND story_id IN (SELECT id FROM stories WHERE project_id = ?)', [m.user_id, a.project.id]);
        db.run('DELETE FROM story_followers WHERE user_id = ? AND story_id IN (SELECT id FROM stories WHERE project_id = ?)', [m.user_id, a.project.id]);
        const p = db.get('SELECT name FROM users WHERE id = ?', [m.user_id])!;
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'project_membership_delete_activity',
          highlight: 'removed',
          message: m.user_id === u.id ? 'left the project' : `removed ${p.name} from the project`,
          primary_resources: [{ kind: 'person', id: m.user_id, name: p.name }],
        });
      });
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ Labels
  const labelWithCounts = (l: Row) => ({
    kind: 'label',
    id: l.id,
    project_id: l.project_id,
    name: l.name,
    story_count: l.story_count ?? 0,
    epic_id: l.epic_id ?? null,
    created_at: l.created_at,
    updated_at: l.updated_at,
  });
  const labelQuery = `SELECT l.*, (SELECT COUNT(*) FROM story_labels sl WHERE sl.label_id = l.id) AS story_count,
                             (SELECT e.id FROM epics e WHERE e.label_id = l.id) AS epic_id
                        FROM labels l`;

  app.get(
    '/projects/:project_id/labels',
    { schema: { tags: ['Labels'], summary: 'List labels', params: P, response: { 200: Type.Array(ref('LabelWithCounts')) } } },
    async (req) => {
      access(ctx, pid(req), req.user, 'viewer');
      return db.all(`${labelQuery} WHERE l.project_id = ? ORDER BY l.name COLLATE NOCASE`, [pid(req)]).map(labelWithCounts);
    },
  );

  app.post(
    '/projects/:project_id/labels',
    {
      schema: {
        tags: ['Labels'],
        summary: 'Create a label',
        description: 'Returns the existing label if one with the same name (case-insensitive) exists.',
        params: P,
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }) }),
        response: { 201: ref('LabelWithCounts') },
      },
    },
    async (req, reply) => {
      access(ctx, pid(req), requireUser(req), 'member');
      const id = findOrCreateLabel(ctx, pid(req), (req.body as any).name.trim());
      return reply.status(201).send(labelWithCounts(db.get(`${labelQuery} WHERE l.id = ?`, [id])!));
    },
  );

  app.put(
    '/projects/:project_id/labels/:label_id',
    {
      schema: {
        tags: ['Labels'],
        summary: 'Rename a label',
        params: Type.Object({ project_id: Type.Integer(), label_id: Type.Integer() }),
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }) }),
        response: { 200: ref('LabelWithCounts') },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const id = (req.params as any).label_id;
      const l = db.get('SELECT * FROM labels WHERE id = ? AND project_id = ?', [id, a.project.id]);
      if (!l) throw notFound('Label');
      const name = (req.body as any).name.trim();
      const clash = db.get('SELECT id FROM labels WHERE project_id = ? AND name = ? COLLATE NOCASE AND id != ?', [a.project.id, name, id]);
      if (clash) throw conflict('A label with that name already exists.');
      ctx.tx(() => {
        db.update('labels', id, { name, updated_at: now() });
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'label_update_activity',
          highlight: 'renamed',
          message: `renamed label "${l.name}" to "${name}"`,
          primary_resources: [{ kind: 'label', id, name }],
        });
      });
      return labelWithCounts(db.get(`${labelQuery} WHERE l.id = ?`, [id])!);
    },
  );

  app.delete(
    '/projects/:project_id/labels/:label_id',
    {
      schema: {
        tags: ['Labels'],
        summary: 'Delete a label',
        description: 'Removes the label from all stories. Labels that belong to an epic cannot be deleted (delete the epic first).',
        params: Type.Object({ project_id: Type.Integer(), label_id: Type.Integer() }),
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const id = (req.params as any).label_id;
      const l = db.get('SELECT * FROM labels WHERE id = ? AND project_id = ?', [id, a.project.id]);
      if (!l) throw notFound('Label');
      if (db.get('SELECT 1 FROM epics WHERE label_id = ?', [id])) throw conflict('This label belongs to an epic.');
      ctx.tx(() => {
        db.run('DELETE FROM labels WHERE id = ?', [id]);
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'label_delete_activity',
          highlight: 'deleted',
          message: `deleted label "${l.name}"`,
          primary_resources: [{ kind: 'label', id, name: l.name }],
        });
      });
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ Epics
  const EpicParams = Type.Object({ project_id: Type.Integer(), epic_id: Type.Integer() });
  const epicRow = (projectId: number, id: number) => {
    const e = db.get('SELECT * FROM epics WHERE id = ? AND project_id = ?', [id, projectId]);
    if (!e) throw notFound('Epic');
    return e;
  };
  const epicPosition = (projectId: number, before?: number | null, after?: number | null, moving?: number) => {
    const list = db.all<{ id: number; position: number }>('SELECT id, position FROM epics WHERE project_id = ? AND id != ? ORDER BY position', [
      projectId,
      moving ?? -1,
    ]);
    const idx = before ? list.findIndex((e) => e.id === before) : after ? list.findIndex((e) => e.id === after) + 1 : list.length;
    if ((before || after) && idx < 0) throw badRequest('before_id/after_id must be an epic in this project.');
    const lo = idx > 0 ? list[idx - 1].position : null;
    const hi = idx < list.length ? list[idx].position : null;
    if (lo == null && hi == null) return 1024;
    if (lo == null) return hi! - 1024;
    if (hi == null) return lo + 1024;
    return (lo + hi) / 2;
  };

  app.get(
    '/projects/:project_id/epics',
    { schema: { tags: ['Epics'], summary: 'List epics', description: 'In priority order, with progress statistics.', params: P, response: { 200: Type.Array(ref('Epic')) } } },
    async (req) => {
      access(ctx, pid(req), req.user, 'viewer');
      return db.all('SELECT * FROM epics WHERE project_id = ? ORDER BY position', [pid(req)]).map((e) => epicJson(ctx, e));
    },
  );

  app.get(
    '/projects/:project_id/epics/:epic_id',
    { schema: { tags: ['Epics'], summary: 'Get an epic', description: 'Includes comments.', params: EpicParams, response: { 200: ref('Epic') } } },
    async (req) => {
      access(ctx, pid(req), req.user, 'viewer');
      return epicJson(ctx, epicRow(pid(req), (req.params as any).epic_id), true);
    },
  );

  app.post(
    '/projects/:project_id/epics',
    {
      schema: {
        tags: ['Epics'],
        summary: 'Create an epic',
        description: 'An epic groups stories through its label. If no label is given, one named after the epic is created (or reused).',
        params: P,
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 5000 }),
          description: Type.Optional(Type.String()),
          label: Type.Optional(Type.Object({ name: Type.String() })),
          label_id: Type.Optional(Type.Integer()),
          before_id: Type.Optional(Nullable(Type.Integer())),
          after_id: Type.Optional(Nullable(Type.Integer())),
        }),
        response: { 201: ref('Epic') },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const b = req.body as any;
      const id = ctx.tx(() => {
        let labelId: number;
        if (b.label_id) {
          if (!db.get('SELECT 1 FROM labels WHERE id = ? AND project_id = ?', [b.label_id, a.project.id])) throw badRequest('Unknown label_id.');
          labelId = b.label_id;
        } else labelId = findOrCreateLabel(ctx, a.project.id, (b.label?.name ?? b.name).trim().toLowerCase());
        if (db.get('SELECT 1 FROM epics WHERE label_id = ?', [labelId])) throw conflict('That label already belongs to an epic.');
        const ts = now();
        const id = db.insert('epics', {
          project_id: a.project.id,
          label_id: labelId,
          name: b.name.trim(),
          description: b.description ?? '',
          position: epicPosition(a.project.id, b.before_id, b.after_id),
          created_at: ts,
          updated_at: ts,
        });
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'epic_create_activity',
          highlight: 'added',
          message: `added epic "${b.name.trim()}"`,
          primary_resources: [{ kind: 'epic', id, name: b.name.trim() }],
        });
        return id;
      });
      return reply.status(201).send(epicJson(ctx, epicRow(a.project.id, id)));
    },
  );

  app.put(
    '/projects/:project_id/epics/:epic_id',
    {
      schema: {
        tags: ['Epics'],
        summary: 'Update an epic',
        description: 'Rename, re-describe, change label name, or reorder with before_id/after_id.',
        params: EpicParams,
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1 })),
          description: Type.Optional(Type.String()),
          label: Type.Optional(Type.Object({ name: Type.String({ minLength: 1 }) })),
          before_id: Type.Optional(Nullable(Type.Integer())),
          after_id: Type.Optional(Nullable(Type.Integer())),
        }),
        response: { 200: ref('Epic') },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const e = epicRow(a.project.id, (req.params as any).epic_id);
      const b = req.body as any;
      ctx.tx(() => {
        const upd: Record<string, any> = { updated_at: now() };
        if (b.name) upd.name = b.name.trim();
        if (b.description !== undefined) upd.description = b.description;
        if (b.before_id || b.after_id) upd.position = epicPosition(a.project.id, b.before_id, b.after_id, e.id);
        if (b.label?.name) {
          const n = b.label.name.trim();
          if (db.get('SELECT 1 FROM labels WHERE project_id = ? AND name = ? COLLATE NOCASE AND id != ?', [a.project.id, n, e.label_id])) {
            throw conflict('A label with that name already exists.');
          }
          db.update('labels', e.label_id, { name: n, updated_at: now() });
        }
        db.update('epics', e.id, upd);
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'epic_update_activity',
          highlight: b.before_id || b.after_id ? 'moved' : 'edited',
          message: `${b.before_id || b.after_id ? 'moved' : 'edited'} epic "${upd.name ?? e.name}"`,
          primary_resources: [{ kind: 'epic', id: e.id, name: upd.name ?? e.name }],
        });
      });
      return epicJson(ctx, epicRow(a.project.id, e.id), true);
    },
  );

  app.delete(
    '/projects/:project_id/epics/:epic_id',
    {
      schema: {
        tags: ['Epics'],
        summary: 'Delete an epic',
        description: 'The epic label and its stories are kept.',
        params: EpicParams,
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const e = epicRow(a.project.id, (req.params as any).epic_id);
      ctx.tx(() => {
        db.run('DELETE FROM epics WHERE id = ?', [e.id]);
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'epic_delete_activity',
          highlight: 'deleted',
          message: `deleted epic "${e.name}"`,
          primary_resources: [{ kind: 'epic', id: e.id, name: e.name }],
        });
      });
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ Iteration overrides
  const overrideJson = (o: Row) => ({
    kind: 'iteration_override',
    project_id: o.project_id,
    number: o.number,
    length: o.length ?? null,
    team_strength: o.team_strength,
  });

  app.get(
    '/projects/:project_id/iteration_overrides',
    {
      schema: {
        tags: ['Iterations'],
        summary: 'List iteration overrides',
        description: 'Per-iteration length and team strength adjustments.',
        params: P,
        response: { 200: Type.Array(ref('IterationOverride')) },
      },
    },
    async (req) => {
      access(ctx, pid(req), req.user, 'viewer');
      return db.all('SELECT * FROM iteration_overrides WHERE project_id = ? ORDER BY number', [pid(req)]).map(overrideJson);
    },
  );

  app.put(
    '/projects/:project_id/iteration_overrides/:number',
    {
      schema: {
        tags: ['Iterations'],
        summary: 'Set an iteration override',
        description:
          'Adjust one iteration. team_strength scales its capacity (e.g. 0.5 during holidays; 0 skips it). length (weeks) changes its duration and shifts all later iteration dates.',
        params: Type.Object({ project_id: Type.Integer(), number: Type.Integer({ minimum: 1 }) }),
        body: Type.Object({
          length: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 8 }))),
          team_strength: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })),
        }),
        response: { 200: ref('IterationOverride') },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const n = (req.params as any).number;
      const b = req.body as any;
      ctx.tx(() => {
        const existing = db.get('SELECT * FROM iteration_overrides WHERE project_id = ? AND number = ?', [a.project.id, n]);
        const length = b.length !== undefined ? b.length : (existing?.length ?? null);
        const strength = b.team_strength ?? existing?.team_strength ?? 1;
        db.run(
          `INSERT INTO iteration_overrides (project_id, number, length, team_strength) VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, number) DO UPDATE SET length = excluded.length, team_strength = excluded.team_strength`,
          [a.project.id, n, length, strength],
        );
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'iteration_update_activity',
          highlight: 'changed',
          message: `changed iteration ${n} (team strength ${Math.round(strength * 100)}%${length ? `, ${length} week${length === 1 ? '' : 's'}` : ''})`,
          changes: [{ kind: 'iteration', change_type: 'update', id: n, new_values: { length, team_strength: strength } }],
        });
      });
      return overrideJson(db.get('SELECT * FROM iteration_overrides WHERE project_id = ? AND number = ?', [a.project.id, n])!);
    },
  );

  app.delete(
    '/projects/:project_id/iteration_overrides/:number',
    {
      schema: {
        tags: ['Iterations'],
        summary: 'Clear an iteration override',
        params: Type.Object({ project_id: Type.Integer(), number: Type.Integer() }),
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const n = (req.params as any).number;
      ctx.tx(() => {
        db.run('DELETE FROM iteration_overrides WHERE project_id = ? AND number = ?', [a.project.id, n]);
        recordActivity(ctx, { project_id: a.project.id, performer: u, kind: 'iteration_update_activity', highlight: 'reset', message: `reset iteration ${n} to defaults` });
      });
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ Webhooks
  const HookParams = Type.Object({ project_id: Type.Integer(), webhook_id: Type.Integer() });
  const hookRow = (projectId: number, id: number) => {
    const w = db.get('SELECT * FROM webhooks WHERE id = ? AND project_id = ?', [id, projectId]);
    if (!w) throw notFound('Webhook');
    return w;
  };
  const validUrl = (u: string) => assertSafeWebhookUrl(u, ctx.config.webhookAllowPrivate);

  app.get(
    '/projects/:project_id/webhooks',
    { schema: { tags: ['Webhooks'], summary: 'List webhooks', description: 'Owner only.', params: P, response: { 200: Type.Array(ref('Webhook')) } } },
    async (req) => {
      access(ctx, pid(req), requireUser(req), 'owner');
      return db.all('SELECT * FROM webhooks WHERE project_id = ? ORDER BY id', [pid(req)]).map(webhookJson);
    },
  );

  app.post(
    '/projects/:project_id/webhooks',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Create a webhook',
        description: 'Every activity in the project is POSTed as JSON (the Activity resource) to the URL. A signing secret is generated.',
        params: P,
        body: Type.Object({ url: Type.String({ maxLength: 2000 }), enabled: Type.Optional(Type.Boolean()) }),
        response: { 201: ref('Webhook') },
      },
    },
    async (req, reply) => {
      const a = access(ctx, pid(req), requireUser(req), 'owner');
      const b = req.body as any;
      await validUrl(b.url);
      const ts = now();
      const id = db.insert('webhooks', { project_id: a.project.id, url: b.url, secret: randomToken(24), enabled: b.enabled === false ? 0 : 1, created_at: ts, updated_at: ts });
      return reply.status(201).send(webhookJson(hookRow(a.project.id, id)));
    },
  );

  app.put(
    '/projects/:project_id/webhooks/:webhook_id',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Update a webhook',
        params: HookParams,
        body: Type.Object({ url: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()), regenerate_secret: Type.Optional(Type.Boolean()) }),
        response: { 200: ref('Webhook') },
      },
    },
    async (req) => {
      const a = access(ctx, pid(req), requireUser(req), 'owner');
      const w = hookRow(a.project.id, (req.params as any).webhook_id);
      const b = req.body as any;
      if (b.url) await validUrl(b.url);
      db.update('webhooks', w.id, {
        ...(b.url ? { url: b.url } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled ? 1 : 0 } : {}),
        ...(b.regenerate_secret ? { secret: randomToken(24) } : {}),
        updated_at: now(),
      });
      return webhookJson(hookRow(a.project.id, w.id));
    },
  );

  app.delete(
    '/projects/:project_id/webhooks/:webhook_id',
    { schema: { tags: ['Webhooks'], summary: 'Delete a webhook', params: HookParams, response: { 200: ref(Ok) } } },
    async (req) => {
      const a = access(ctx, pid(req), requireUser(req), 'owner');
      db.run('DELETE FROM webhooks WHERE id = ?', [hookRow(a.project.id, (req.params as any).webhook_id).id]);
      return { ok: true };
    },
  );

  app.post(
    '/projects/:project_id/webhooks/:webhook_id/test',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Send a test delivery',
        description: 'Sends a `ping` payload and returns the result.',
        params: HookParams,
        response: { 200: Type.Object({ status: Nullable(Type.Integer()), error: Nullable(Type.String()) }) },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'owner');
      const w = hookRow(a.project.id, (req.params as any).webhook_id);
      return deliverOne(ctx, w, {
        kind: 'ping',
        message: `${u.name} sent a test webhook`,
        project: { kind: 'project', id: a.project.id, name: a.project.name },
        occurred_at: now(),
      });
    },
  );

  // ------------------------------------------------------------------ Review types
  const RtParams = Type.Object({ project_id: Type.Integer(), review_type_id: Type.Integer() });

  app.get(
    '/projects/:project_id/review_types',
    { schema: { tags: ['Reviews'], summary: 'List review types', params: P, response: { 200: Type.Array(ref('ReviewType')) } } },
    async (req) => {
      access(ctx, pid(req), req.user, 'viewer');
      return db.all('SELECT * FROM review_types WHERE project_id = ? ORDER BY id', [pid(req)]).map(reviewTypeJson);
    },
  );

  app.post(
    '/projects/:project_id/review_types',
    {
      schema: {
        tags: ['Reviews'],
        summary: 'Create a review type',
        params: P,
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }), hidden: Type.Optional(Type.Boolean()) }),
        response: { 201: ref('ReviewType') },
      },
    },
    async (req, reply) => {
      const a = access(ctx, pid(req), requireUser(req), 'owner');
      const b = req.body as any;
      const ts = now();
      const id = db.insert('review_types', { project_id: a.project.id, name: b.name.trim(), hidden: b.hidden ? 1 : 0, created_at: ts, updated_at: ts });
      return reply.status(201).send(reviewTypeJson(db.get('SELECT * FROM review_types WHERE id = ?', [id])!));
    },
  );

  app.put(
    '/projects/:project_id/review_types/:review_type_id',
    {
      schema: {
        tags: ['Reviews'],
        summary: 'Update a review type',
        description: 'Hidden review types cannot be added to stories but existing reviews remain.',
        params: RtParams,
        body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1 })), hidden: Type.Optional(Type.Boolean()) }),
        response: { 200: ref('ReviewType') },
      },
    },
    async (req) => {
      const a = access(ctx, pid(req), requireUser(req), 'owner');
      const id = (req.params as any).review_type_id;
      if (!db.get('SELECT 1 FROM review_types WHERE id = ? AND project_id = ?', [id, a.project.id])) throw notFound('Review type');
      const b = req.body as any;
      db.update('review_types', id, { ...(b.name ? { name: b.name.trim() } : {}), ...(b.hidden !== undefined ? { hidden: b.hidden ? 1 : 0 } : {}), updated_at: now() });
      return reviewTypeJson(db.get('SELECT * FROM review_types WHERE id = ?', [id])!);
    },
  );

  app.delete(
    '/projects/:project_id/review_types/:review_type_id',
    {
      schema: {
        tags: ['Reviews'],
        summary: 'Delete a review type',
        description: 'Also deletes all reviews of this type.',
        params: RtParams,
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const a = access(ctx, pid(req), requireUser(req), 'owner');
      const id = (req.params as any).review_type_id;
      if (!db.get('SELECT 1 FROM review_types WHERE id = ? AND project_id = ?', [id, a.project.id])) throw notFound('Review type');
      db.run('DELETE FROM review_types WHERE id = ?', [id]);
      return { ok: true };
    },
  );
}

function ensureAnotherOwner(ctx: Ctx, projectId: number, userId: number) {
  const others = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE project_id = ? AND role = 'owner' AND user_id != ?", [projectId, userId])!.n;
  if (others === 0) throw badRequest('A project must have at least one owner.');
}

