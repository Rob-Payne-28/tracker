import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { paginate, requireUser } from '../app.js';
import { ref, Ok, Pagination } from '../schemas.js';
import { listActivities, notificationJson } from '../services/activity.js';
import { hydrate, type StoryRow } from '../services/stories.js';
import { access } from '../services/projects.js';
import { ApiError, badRequest, notFound } from '../lib/errors.js';
import { now, type Row } from '../db/index.js';
import type { StreamEvent } from '../services/context.js';

function workspaceJson(w: Row) {
  return { kind: 'workspace', id: w.id, name: w.name, project_ids: JSON.parse(w.project_ids), created_at: w.created_at, updated_at: w.updated_at };
}

export async function personalRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const db = ctx.db;

  // ------------------------------------------------------------------ Notifications
  app.get(
    '/my/notifications',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'List your notifications',
        description: 'Newest first. The X-Unread-Count header holds the number of unread notifications.',
        querystring: Type.Composite([Pagination, Type.Object({ unread_only: Type.Optional(Type.Boolean()) })]),
        response: { 200: Type.Array(ref('Notification')) },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const q = req.query as any;
      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      const where = `user_id = ?${q.unread_only ? ' AND read_at IS NULL' : ''}`;
      const rows = db.all(`SELECT * FROM notifications WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [u.id, limit, offset]);
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`, [u.id])!.n;
      const unread = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [u.id])!.n;
      paginate(reply, total, limit, offset, rows.length);
      reply.header('X-Unread-Count', String(unread));
      return rows.map((n) => notificationJson(ctx, n));
    },
  );

  app.put(
    '/my/notifications/:id',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'Mark a notification read or unread',
        params: Type.Object({ id: Type.Integer() }),
        body: Type.Object({ read: Type.Boolean() }),
        response: { 200: ref('Notification') },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const id = (req.params as any).id;
      const n = db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [id, u.id]);
      if (!n) throw notFound('Notification');
      db.run('UPDATE notifications SET read_at = ? WHERE id = ?', [(req.body as any).read ? now() : null, id]);
      return notificationJson(ctx, db.get('SELECT * FROM notifications WHERE id = ?', [id])!);
    },
  );

  app.post(
    '/my/notifications/mark_all_read',
    { schema: { tags: ['Notifications'], summary: 'Mark all notifications read', response: { 200: ref(Ok) } } },
    async (req) => {
      const u = requireUser(req);
      db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now(), u.id]);
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ My work
  app.get(
    '/my/work',
    {
      schema: {
        tags: ['My work'],
        summary: 'Your work across projects',
        description:
          'Stories you own that are not yet accepted, delivered stories you requested (awaiting your acceptance), and stories with reviews assigned to you that are not finished. Optionally limit to one project.',
        querystring: Type.Object({ project_id: Type.Optional(Type.Integer()) }),
        response: {
          200: Type.Object({
            owned: Type.Array(ref('Story')),
            to_accept: Type.Array(ref('Story')),
            to_review: Type.Array(ref('Story')),
          }),
        },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const pid = (req.query as any).project_id;
      if (pid) access(ctx, pid, u, 'viewer');
      const scope = pid ? 'AND s.project_id = ?' : 'AND s.project_id IN (SELECT project_id FROM memberships WHERE user_id = ?)';
      const sp = pid ?? u.id;
      const STATE_ORDER = `CASE s.current_state WHEN 'rejected' THEN 0 WHEN 'started' THEN 1 WHEN 'finished' THEN 2 WHEN 'delivered' THEN 3 WHEN 'unstarted' THEN 4 ELSE 5 END`;
      const owned = db.all<StoryRow>(
        `SELECT s.* FROM stories s JOIN story_owners o ON o.story_id = s.id WHERE o.user_id = ? AND s.current_state != 'accepted' ${scope}
          ORDER BY ${STATE_ORDER}, s.project_id, s.position`,
        [u.id, sp],
      );
      const toAccept = db.all<StoryRow>(
        `SELECT s.* FROM stories s WHERE s.requested_by_id = ? AND s.current_state = 'delivered' ${scope} ORDER BY s.updated_at`,
        [u.id, sp],
      );
      const toReview = db.all<StoryRow>(
        `SELECT DISTINCT s.* FROM stories s JOIN reviews r ON r.story_id = s.id
          WHERE r.reviewer_id = ? AND r.status IN ('unstarted','in_review') AND s.current_state != 'accepted' ${scope} ORDER BY s.position`,
        [u.id, sp],
      );
      return { owned: hydrate(ctx, owned), to_accept: hydrate(ctx, toAccept), to_review: hydrate(ctx, toReview) };
    },
  );

  app.get(
    '/my/activity',
    {
      schema: {
        tags: ['Activity'],
        summary: 'Your activity',
        description: 'Activity you performed, across all projects you are still a member of.',
        querystring: Pagination,
        response: { 200: Type.Array(ref('Activity')) },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const q = req.query as any;
      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      const { items, total } = listActivities(
        ctx,
        'a.performed_by_id = ? AND a.project_id IN (SELECT project_id FROM memberships WHERE user_id = ?)',
        [u.id, u.id],
        limit,
        offset,
      );
      paginate(reply, total, limit, offset, items.length);
      return items;
    },
  );

  // ------------------------------------------------------------------ Workspaces
  const WsBody = Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), project_ids: Type.Array(Type.Integer()) });
  const checkProjects = (userId: number, ids: number[]) => {
    for (const id of ids) {
      if (!db.get('SELECT 1 FROM memberships WHERE project_id = ? AND user_id = ?', [id, userId])) throw badRequest(`You are not a member of project ${id}.`);
    }
  };
  const wsRow = (userId: number, id: number) => {
    const w = db.get('SELECT * FROM workspaces WHERE id = ? AND user_id = ?', [id, userId]);
    if (!w) throw notFound('Workspace');
    return w;
  };

  app.get(
    '/my/workspaces',
    {
      schema: {
        tags: ['Workspaces'],
        summary: 'List your workspaces',
        description: 'Workspaces are personal views that show several projects side by side.',
        response: { 200: Type.Array(ref('Workspace')) },
      },
    },
    async (req) => db.all('SELECT * FROM workspaces WHERE user_id = ? ORDER BY name COLLATE NOCASE', [requireUser(req).id]).map(workspaceJson),
  );

  app.post(
    '/my/workspaces',
    { schema: { tags: ['Workspaces'], summary: 'Create a workspace', body: WsBody, response: { 201: ref('Workspace') } } },
    async (req, reply) => {
      const u = requireUser(req);
      const b = req.body as any;
      checkProjects(u.id, b.project_ids);
      const ts = now();
      const id = db.insert('workspaces', { user_id: u.id, name: b.name.trim(), project_ids: JSON.stringify([...new Set(b.project_ids)]), created_at: ts, updated_at: ts });
      return reply.status(201).send(workspaceJson(wsRow(u.id, id)));
    },
  );

  app.put(
    '/my/workspaces/:id',
    {
      schema: { tags: ['Workspaces'], summary: 'Update a workspace', params: Type.Object({ id: Type.Integer() }), body: Type.Partial(WsBody), response: { 200: ref('Workspace') } },
    },
    async (req) => {
      const u = requireUser(req);
      const w = wsRow(u.id, (req.params as any).id);
      const b = req.body as any;
      if (b.project_ids) checkProjects(u.id, b.project_ids);
      db.update('workspaces', w.id, {
        ...(b.name ? { name: b.name.trim() } : {}),
        ...(b.project_ids ? { project_ids: JSON.stringify([...new Set(b.project_ids)]) } : {}),
        updated_at: now(),
      });
      return workspaceJson(wsRow(u.id, w.id));
    },
  );

  app.delete(
    '/my/workspaces/:id',
    { schema: { tags: ['Workspaces'], summary: 'Delete a workspace', params: Type.Object({ id: Type.Integer() }), response: { 200: ref(Ok) } } },
    async (req) => {
      const u = requireUser(req);
      db.run('DELETE FROM workspaces WHERE id = ?', [wsRow(u.id, (req.params as any).id).id]);
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ Realtime (Server-Sent Events)
  app.addHook('onClose', async () => ctx.streams.closeAll());
  app.get(
    '/events',
    {
      config: { allowQueryToken: true },
      schema: {
        tags: ['Realtime'],
        summary: 'Live event stream (Server-Sent Events)',
        description: `Opens a \`text/event-stream\`. Subscribe to projects with \`project_ids=1,2\`; your own notifications are always included. Because browsers' EventSource cannot send headers, the API token may be passed as \`?token=\`.

Events:
* \`activity\` — data is an Activity (a project changed; refetch or apply).
* \`notification\` — data is a Notification for you.
* \`project\` — project-level events such as deletion.
* \`ping\` — keep-alive every 25 s.`,
        querystring: Type.Object({ project_ids: Type.Optional(Type.String()), token: Type.Optional(Type.String()) }),
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const ids = String((req.query as any).project_ids ?? '')
        .split(',')
        .map(Number)
        .filter((n) => n > 0);
      for (const id of ids) access(ctx, id, u, 'viewer');
      let release: (() => void) | null = null;
      const end = () => {
        close();
        reply.raw.end();
      };
      release = ctx.streams.open(u.id, end);
      if (!release) {
        throw new ApiError(429, 'too_many_requests', `Too many open event streams (limit ${ctx.config.maxStreamsPerUser}).`, 'Close other tabs or reuse one connection.');
      }
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const send = (ev: StreamEvent) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
      const channels = [...ids.map((id) => `project:${id}`), `user:${u.id}`];
      for (const ch of channels) ctx.events.on(ch, send);
      const ping = setInterval(() => res.write(`event: ping\ndata: {}\n\n`), 25_000);
      function close() {
        clearInterval(ping);
        for (const ch of channels) ctx.events.off(ch, send);
        release?.();
      }
      req.raw.on('close', close);
    },
  );
}
