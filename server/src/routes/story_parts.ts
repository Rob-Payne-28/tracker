import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { requireUser } from '../app.js';
import { ref, Ok, StoryParams, ReviewStatusEnum, Nullable } from '../schemas.js';
import { access, isMember, type Access } from '../services/projects.js';
import { blockerJson, commentsJson, getStoryRow, reviewJson, taskJson, type StoryRow } from '../services/stories.js';
import { recordActivity, notify, mentionedUserIds, storyUrl } from '../services/activity.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { now, type Row } from '../db/index.js';
import type { User } from '../services/people.js';
import type { Ctx } from '../services/context.js';

const res = (ctx: Ctx, s: StoryRow) => [{ kind: 'story', id: s.id, name: s.name, story_type: s.story_type, url: storyUrl(ctx, s.project_id, s.id) }];
const touch = (ctx: Ctx, s: StoryRow) => ctx.db.run('UPDATE stories SET updated_at = ? WHERE id = ?', [now(), s.id]);
const excerpt = (t: string, n = 80) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

export function createComment(
  ctx: Ctx,
  a: Access,
  u: User | null,
  target: { story?: StoryRow; epic?: Row },
  b: { text?: string; file_attachment_ids?: number[]; commit_identifier?: string | null; commit_type?: string | null },
) {
  const db = ctx.db;
  const text = (b.text ?? '').trim();
  const files = b.file_attachment_ids ?? [];
  if (!text && !files.length) throw badRequest('A comment needs text or attachments.');
  return ctx.tx(() => {
    const ts = now();
    const id = db.insert('comments', {
      project_id: a.project.id,
      story_id: target.story?.id ?? null,
      epic_id: target.epic?.id ?? null,
      person_id: u?.id ?? null,
      text,
      commit_identifier: b.commit_identifier ?? null,
      commit_type: b.commit_type ?? null,
      created_at: ts,
      updated_at: ts,
    });
    for (const fid of files) {
      const f = db.get('SELECT * FROM attachments WHERE id = ? AND project_id = ?', [fid, a.project.id]);
      if (!f) throw badRequest(`File attachment ${fid} not found.`);
      if (f.comment_id) throw badRequest(`File attachment ${fid} is already attached to a comment.`);
      if (u && f.uploader_id !== u.id) throw forbidden('You can only attach files you uploaded.');
      db.run('UPDATE attachments SET comment_id = ? WHERE id = ?', [id, fid]);
    }
    const subject = target.story ?? target.epic!;
    const actor = u?.name ?? 'Someone';
    if (target.story) {
      touch(ctx, target.story);
      if (u) db.run('INSERT OR IGNORE INTO story_followers (story_id, user_id) VALUES (?, ?)', [target.story.id, u.id]);
    }
    recordActivity(ctx, {
      project_id: a.project.id,
      performer: u,
      kind: 'comment_create_activity',
      highlight: 'added comment:',
      message: `added comment: "${excerpt(text || `${files.length} file(s)`)}"`,
      changes: [{ kind: 'comment', change_type: 'create', id, new_values: { text, story_id: target.story?.id ?? null, epic_id: target.epic?.id ?? null, file_attachment_ids: files } }],
      primary_resources: target.story ? res(ctx, target.story) : [{ kind: 'epic', id: subject.id, name: subject.name }],
      story_ids: target.story ? [target.story.id] : [],
    });
    const mentioned = mentionedUserIds(ctx, a.project.id, text);
    notify(ctx, {
      user_ids: mentioned,
      performer: u,
      project_id: a.project.id,
      story_id: target.story?.id,
      epic_id: target.epic?.id,
      notification_type: 'mention',
      message: `${actor} mentioned you in a comment on "${subject.name}"`,
      context: text,
    });
    if (target.story) {
      const followers = db
        .all<{ user_id: number }>('SELECT user_id FROM story_followers WHERE story_id = ?', [target.story.id])
        .map((f) => f.user_id)
        .filter((id) => !mentioned.includes(id));
      notify(ctx, {
        user_ids: followers,
        performer: u,
        project_id: a.project.id,
        story_id: target.story.id,
        notification_type: 'comment',
        message: `${actor} commented on "${target.story.name}"`,
        context: text,
      });
    }
    return commentsJson(ctx, [db.get('SELECT * FROM comments WHERE id = ?', [id])!])[0];
  });
}

export async function storyPartsRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const db = ctx.db;
  const pid = (req: any) => Number(req.params.project_id);
  const sid = (req: any) => Number(req.params.story_id);
  const ctxFor = (req: any, need: 'viewer' | 'member' = 'member') => {
    const u = need === 'viewer' ? req.user : requireUser(req);
    const a = access(ctx, pid(req), u, need);
    return { u, a, s: getStoryRow(ctx, sid(req), a.project.id) };
  };

  // ------------------------------------------------------------------ Tasks
  const TaskParams = Type.Object({ project_id: Type.Integer(), story_id: Type.Integer(), task_id: Type.Integer() });
  const taskRow = (s: StoryRow, id: number) => {
    const t = db.get('SELECT * FROM tasks WHERE id = ? AND story_id = ?', [id, s.id]);
    if (!t) throw notFound('Task');
    return t;
  };
  const reorderTasks = (storyId: number, taskId: number, position: number) => {
    const list = db.all<{ id: number }>('SELECT id FROM tasks WHERE story_id = ? AND id != ? ORDER BY position, id', [storyId, taskId]).map((t) => t.id);
    list.splice(Math.max(0, Math.min(list.length, position - 1)), 0, taskId);
    list.forEach((id, i) => db.run('UPDATE tasks SET position = ? WHERE id = ?', [i + 1, id]));
  };

  app.get(
    '/projects/:project_id/stories/:story_id/tasks',
    { schema: { tags: ['Tasks'], summary: 'List tasks', params: StoryParams, response: { 200: Type.Array(ref('Task')) } } },
    async (req) => {
      const { s } = ctxFor(req, 'viewer');
      return db.all('SELECT * FROM tasks WHERE story_id = ? ORDER BY position, id', [s.id]).map(taskJson);
    },
  );

  app.post(
    '/projects/:project_id/stories/:story_id/tasks',
    {
      schema: {
        tags: ['Tasks'],
        summary: 'Add a task',
        params: StoryParams,
        body: Type.Object({
          description: Type.String({ minLength: 1, maxLength: 5000 }),
          complete: Type.Optional(Type.Boolean()),
          position: Type.Optional(Type.Integer({ minimum: 1, description: '1-based; defaults to last' })),
        }),
        response: { 201: ref('Task') },
      },
    },
    async (req, reply) => {
      const { u, a, s } = ctxFor(req);
      const b = req.body as any;
      const id = ctx.tx(() => {
        const ts = now();
        const max = db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM tasks WHERE story_id = ?', [s.id])!.m ?? 0;
        const id = db.insert('tasks', { story_id: s.id, description: b.description.trim(), complete: b.complete ? 1 : 0, position: max + 1, created_at: ts, updated_at: ts });
        if (b.position) reorderTasks(s.id, id, b.position);
        touch(ctx, s);
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'task_create_activity',
          highlight: 'added task:',
          message: `added task "${excerpt(b.description.trim())}" to "${s.name}"`,
          changes: [{ kind: 'task', change_type: 'create', id, new_values: { description: b.description.trim(), complete: !!b.complete } }],
          primary_resources: res(ctx, s),
          story_ids: [s.id],
        });
        return id;
      });
      return reply.status(201).send(taskJson(taskRow(s, id)));
    },
  );

  app.put(
    '/projects/:project_id/stories/:story_id/tasks/:task_id',
    {
      schema: {
        tags: ['Tasks'],
        summary: 'Update a task',
        description: 'Edit text, toggle completion, or reorder (position is 1-based).',
        params: TaskParams,
        body: Type.Object({
          description: Type.Optional(Type.String({ minLength: 1, maxLength: 5000 })),
          complete: Type.Optional(Type.Boolean()),
          position: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        response: { 200: ref('Task') },
      },
    },
    async (req) => {
      const { u, a, s } = ctxFor(req);
      const t = taskRow(s, (req.params as any).task_id);
      const b = req.body as any;
      ctx.tx(() => {
        const upd: Record<string, any> = { updated_at: now() };
        if (b.description !== undefined) upd.description = b.description.trim();
        if (b.complete !== undefined) upd.complete = b.complete ? 1 : 0;
        db.update('tasks', t.id, upd);
        if (b.position) reorderTasks(s.id, t.id, b.position);
        touch(ctx, s);
        const verb = b.complete !== undefined && !!b.complete !== !!t.complete ? (b.complete ? 'completed' : 'uncompleted') : 'edited';
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'task_update_activity',
          highlight: verb,
          message: `${verb} task "${excerpt(upd.description ?? t.description)}" on "${s.name}"`,
          changes: [{ kind: 'task', change_type: 'update', id: t.id, original_values: { description: t.description, complete: !!t.complete }, new_values: b }],
          primary_resources: res(ctx, s),
          story_ids: [s.id],
        });
      });
      return taskJson(taskRow(s, t.id));
    },
  );

  app.delete(
    '/projects/:project_id/stories/:story_id/tasks/:task_id',
    { schema: { tags: ['Tasks'], summary: 'Delete a task', params: TaskParams, response: { 200: ref(Ok) } } },
    async (req) => {
      const { u, a, s } = ctxFor(req);
      const t = taskRow(s, (req.params as any).task_id);
      ctx.tx(() => {
        db.run('DELETE FROM tasks WHERE id = ?', [t.id]);
        touch(ctx, s);
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'task_delete_activity',
          highlight: 'deleted task:',
          message: `deleted task "${excerpt(t.description)}" from "${s.name}"`,
          changes: [{ kind: 'task', change_type: 'delete', id: t.id }],
          primary_resources: res(ctx, s),
          story_ids: [s.id],
        });
      });
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ Comments
  const CommentBody = Type.Object({
    text: Type.Optional(Type.String({ maxLength: 100000, description: 'Markdown; @username mentions notify people' })),
    file_attachment_ids: Type.Optional(Type.Array(Type.Integer(), { description: 'Ids returned by the upload endpoint' })),
  });
  const CommentParams = Type.Object({ project_id: Type.Integer(), story_id: Type.Integer(), comment_id: Type.Integer() });

  app.get(
    '/projects/:project_id/stories/:story_id/comments',
    { schema: { tags: ['Comments'], summary: 'List story comments', params: StoryParams, response: { 200: Type.Array(ref('Comment')) } } },
    async (req) => {
      const { s } = ctxFor(req, 'viewer');
      return commentsJson(ctx, db.all('SELECT * FROM comments WHERE story_id = ? ORDER BY id', [s.id]));
    },
  );

  app.post(
    '/projects/:project_id/stories/:story_id/comments',
    {
      schema: {
        tags: ['Comments'],
        summary: 'Comment on a story',
        description: 'Followers and @mentioned members are notified. Commenting makes you a follower. Attach files by uploading them first.',
        params: StoryParams,
        body: CommentBody,
        response: { 201: ref('Comment') },
      },
    },
    async (req, reply) => {
      const { u, a, s } = ctxFor(req);
      return reply.status(201).send(createComment(ctx, a, u, { story: s }, req.body as any));
    },
  );

  const editComment = async (req: any, where: { story_id?: number; epic_id?: number }) => {
    const u = requireUser(req);
    const a = access(ctx, pid(req), u, 'member');
    const c = db.get('SELECT * FROM comments WHERE id = ? AND project_id = ?', [req.params.comment_id, a.project.id]);
    if (!c || (where.story_id && c.story_id !== where.story_id) || (where.epic_id && c.epic_id !== where.epic_id)) throw notFound('Comment');
    return { u, a, c };
  };

  app.put(
    '/projects/:project_id/stories/:story_id/comments/:comment_id',
    {
      schema: {
        tags: ['Comments'],
        summary: 'Edit a comment',
        description: 'Only the author can edit a comment.',
        params: CommentParams,
        body: Type.Object({ text: Type.String({ maxLength: 100000 }) }),
        response: { 200: ref('Comment') },
      },
    },
    async (req) => {
      const { u, a, c } = await editComment(req, { story_id: sid(req) });
      if (c.person_id !== u.id) throw forbidden('You can only edit your own comments.');
      const text = (req.body as any).text.trim();
      ctx.tx(() => {
        db.update('comments', c.id, { text, updated_at: now() });
        const s = getStoryRow(ctx, c.story_id);
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'comment_update_activity',
          highlight: 'edited comment:',
          message: `edited a comment on "${s.name}"`,
          changes: [{ kind: 'comment', change_type: 'update', id: c.id, original_values: { text: c.text }, new_values: { text } }],
          primary_resources: res(ctx, s),
          story_ids: [s.id],
        });
      });
      return commentsJson(ctx, [db.get('SELECT * FROM comments WHERE id = ?', [c.id])!])[0];
    },
  );

  app.delete(
    '/projects/:project_id/stories/:story_id/comments/:comment_id',
    {
      schema: {
        tags: ['Comments'],
        summary: 'Delete a comment',
        description: 'Authors can delete their comments; project owners can delete any comment. Attached files are deleted too.',
        params: CommentParams,
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const { u, a, c } = await editComment(req, { story_id: sid(req) });
      if (c.person_id !== u.id && a.role !== 'owner') throw forbidden('You can only delete your own comments.');
      ctx.tx(() => {
        db.run('DELETE FROM comments WHERE id = ?', [c.id]);
        const s = getStoryRow(ctx, c.story_id);
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'comment_delete_activity',
          highlight: 'deleted comment:',
          message: `deleted a comment on "${s.name}"`,
          changes: [{ kind: 'comment', change_type: 'delete', id: c.id }],
          primary_resources: res(ctx, s),
          story_ids: [s.id],
        });
      });
      return { ok: true };
    },
  );

  // Epic comments
  const EpicParams = Type.Object({ project_id: Type.Integer(), epic_id: Type.Integer() });
  const epicRow = (projectId: number, id: number) => {
    const e = db.get('SELECT * FROM epics WHERE id = ? AND project_id = ?', [id, projectId]);
    if (!e) throw notFound('Epic');
    return e;
  };
  app.get(
    '/projects/:project_id/epics/:epic_id/comments',
    { schema: { tags: ['Comments'], summary: 'List epic comments', params: EpicParams, response: { 200: Type.Array(ref('Comment')) } } },
    async (req) => {
      const a = access(ctx, pid(req), req.user, 'viewer');
      const e = epicRow(a.project.id, (req.params as any).epic_id);
      return commentsJson(ctx, db.all('SELECT * FROM comments WHERE epic_id = ? ORDER BY id', [e.id]));
    },
  );
  app.post(
    '/projects/:project_id/epics/:epic_id/comments',
    { schema: { tags: ['Comments'], summary: 'Comment on an epic', params: EpicParams, body: CommentBody, response: { 201: ref('Comment') } } },
    async (req, reply) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const e = epicRow(a.project.id, (req.params as any).epic_id);
      return reply.status(201).send(createComment(ctx, a, u, { epic: e }, req.body as any));
    },
  );
  app.delete(
    '/projects/:project_id/epics/:epic_id/comments/:comment_id',
    {
      schema: {
        tags: ['Comments'],
        summary: 'Delete an epic comment',
        params: Type.Object({ project_id: Type.Integer(), epic_id: Type.Integer(), comment_id: Type.Integer() }),
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const { u, a, c } = await editComment(req, { epic_id: Number((req.params as any).epic_id) });
      if (c.person_id !== u.id && a.role !== 'owner') throw forbidden('You can only delete your own comments.');
      db.run('DELETE FROM comments WHERE id = ?', [c.id]);
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ Blockers
  const BlockerParams = Type.Object({ project_id: Type.Integer(), story_id: Type.Integer(), blocker_id: Type.Integer() });
  const blockerRow = (s: StoryRow, id: number) => {
    const b = db.get('SELECT * FROM blockers WHERE id = ? AND story_id = ?', [id, s.id]);
    if (!b) throw notFound('Blocker');
    return b;
  };

  app.get(
    '/projects/:project_id/stories/:story_id/blockers',
    { schema: { tags: ['Blockers'], summary: 'List blockers', params: StoryParams, response: { 200: Type.Array(ref('Blocker')) } } },
    async (req) => {
      const { s } = ctxFor(req, 'viewer');
      return db.all('SELECT * FROM blockers WHERE story_id = ? ORDER BY id', [s.id]).map(blockerJson);
    },
  );

  app.post(
    '/projects/:project_id/stories/:story_id/blockers',
    {
      schema: {
        tags: ['Blockers'],
        summary: 'Add a blocker',
        description: 'Describe what is blocking the story. Include "#123" to mark story 123 as the blocker.',
        params: StoryParams,
        body: Type.Object({ description: Type.String({ minLength: 1, maxLength: 5000 }) }),
        response: { 201: ref('Blocker') },
      },
    },
    async (req, reply) => {
      const { u, a, s } = ctxFor(req);
      const description = (req.body as any).description.trim();
      const id = ctx.tx(() => {
        const ts = now();
        const id = db.insert('blockers', { story_id: s.id, person_id: u.id, description, resolved: 0, created_at: ts, updated_at: ts });
        touch(ctx, s);
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'blocker_create_activity',
          highlight: 'added blocker:',
          message: `added blocker "${excerpt(description)}" to "${s.name}"`,
          changes: [{ kind: 'blocker', change_type: 'create', id, new_values: { description } }],
          primary_resources: res(ctx, s),
          story_ids: [s.id],
        });
        return id;
      });
      return reply.status(201).send(blockerJson(blockerRow(s, id)));
    },
  );

  app.put(
    '/projects/:project_id/stories/:story_id/blockers/:blocker_id',
    {
      schema: {
        tags: ['Blockers'],
        summary: 'Update or resolve a blocker',
        params: BlockerParams,
        body: Type.Object({ description: Type.Optional(Type.String({ minLength: 1 })), resolved: Type.Optional(Type.Boolean()) }),
        response: { 200: ref('Blocker') },
      },
    },
    async (req) => {
      const { u, a, s } = ctxFor(req);
      const bl = blockerRow(s, (req.params as any).blocker_id);
      const b = req.body as any;
      ctx.tx(() => {
        db.update('blockers', bl.id, {
          ...(b.description ? { description: b.description.trim() } : {}),
          ...(b.resolved !== undefined ? { resolved: b.resolved ? 1 : 0 } : {}),
          updated_at: now(),
        });
        touch(ctx, s);
        const verb = b.resolved !== undefined && !!b.resolved !== !!bl.resolved ? (b.resolved ? 'resolved' : 'unresolved') : 'edited';
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'blocker_update_activity',
          highlight: `${verb} blocker:`,
          message: `${verb} blocker "${excerpt(b.description ?? bl.description)}" on "${s.name}"`,
          changes: [{ kind: 'blocker', change_type: 'update', id: bl.id, original_values: { description: bl.description, resolved: !!bl.resolved }, new_values: b }],
          primary_resources: res(ctx, s),
          story_ids: [s.id],
        });
      });
      return blockerJson(blockerRow(s, bl.id));
    },
  );

  app.delete(
    '/projects/:project_id/stories/:story_id/blockers/:blocker_id',
    { schema: { tags: ['Blockers'], summary: 'Delete a blocker', params: BlockerParams, response: { 200: ref(Ok) } } },
    async (req) => {
      const { u, a, s } = ctxFor(req);
      const bl = blockerRow(s, (req.params as any).blocker_id);
      ctx.tx(() => {
        db.run('DELETE FROM blockers WHERE id = ?', [bl.id]);
        touch(ctx, s);
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'blocker_delete_activity',
          highlight: 'removed blocker:',
          message: `removed blocker "${excerpt(bl.description)}" from "${s.name}"`,
          changes: [{ kind: 'blocker', change_type: 'delete', id: bl.id }],
          primary_resources: res(ctx, s),
          story_ids: [s.id],
        });
      });
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ Reviews
  const ReviewParams = Type.Object({ project_id: Type.Integer(), story_id: Type.Integer(), review_id: Type.Integer() });
  const reviewRow = (s: StoryRow, id: number) => {
    const r = db.get(
      'SELECT r.*, rt.name AS review_type_name FROM reviews r JOIN review_types rt ON rt.id = r.review_type_id WHERE r.id = ? AND r.story_id = ?',
      [id, s.id],
    );
    if (!r) throw notFound('Review');
    return r;
  };

  app.get(
    '/projects/:project_id/stories/:story_id/reviews',
    { schema: { tags: ['Reviews'], summary: 'List reviews on a story', params: StoryParams, response: { 200: Type.Array(ref('Review')) } } },
    async (req) => {
      const { s } = ctxFor(req, 'viewer');
      return db
        .all('SELECT r.*, rt.name AS review_type_name FROM reviews r JOIN review_types rt ON rt.id = r.review_type_id WHERE r.story_id = ? ORDER BY r.id', [s.id])
        .map(reviewJson);
    },
  );

  app.post(
    '/projects/:project_id/stories/:story_id/reviews',
    {
      schema: {
        tags: ['Reviews'],
        summary: 'Add a review',
        description: 'Request a review (code, design, QA, …) from a project member. The reviewer is notified.',
        params: StoryParams,
        body: Type.Object({
          review_type_id: Type.Integer(),
          reviewer_id: Type.Optional(Nullable(Type.Integer())),
          status: Type.Optional(ReviewStatusEnum),
        }),
        response: { 201: ref('Review') },
      },
    },
    async (req, reply) => {
      const { u, a, s } = ctxFor(req);
      const b = req.body as any;
      const rt = db.get('SELECT * FROM review_types WHERE id = ? AND project_id = ?', [b.review_type_id, a.project.id]);
      if (!rt) throw badRequest('Unknown review_type_id.');
      if (rt.hidden) throw badRequest('That review type is hidden.');
      if (b.reviewer_id && !isMember(ctx, a.project.id, b.reviewer_id)) throw badRequest('Reviewer must be a project member.');
      const id = ctx.tx(() => {
        const ts = now();
        const id = db.insert('reviews', { story_id: s.id, review_type_id: rt.id, reviewer_id: b.reviewer_id ?? null, status: b.status ?? 'unstarted', created_at: ts, updated_at: ts });
        touch(ctx, s);
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'review_create_activity',
          highlight: 'added review:',
          message: `added ${rt.name} review to "${s.name}"`,
          changes: [{ kind: 'review', change_type: 'create', id, new_values: { review_type_id: rt.id, reviewer_id: b.reviewer_id ?? null, status: b.status ?? 'unstarted' } }],
          primary_resources: res(ctx, s),
          story_ids: [s.id],
        });
        if (b.reviewer_id) {
          notify(ctx, {
            user_ids: [b.reviewer_id],
            performer: u,
            project_id: a.project.id,
            story_id: s.id,
            notification_type: 'review_requested',
            message: `${u.name} requested your ${rt.name} review on "${s.name}"`,
          });
        }
        return id;
      });
      return reply.status(201).send(reviewJson(reviewRow(s, id)));
    },
  );

  app.put(
    '/projects/:project_id/stories/:story_id/reviews/:review_id',
    {
      schema: {
        tags: ['Reviews'],
        summary: 'Update a review',
        description: 'Change reviewer, type or status (unstarted → in_review → pass | revise). Story owners are notified of pass/revise.',
        params: ReviewParams,
        body: Type.Object({
          review_type_id: Type.Optional(Type.Integer()),
          reviewer_id: Type.Optional(Nullable(Type.Integer())),
          status: Type.Optional(ReviewStatusEnum),
        }),
        response: { 200: ref('Review') },
      },
    },
    async (req) => {
      const { u, a, s } = ctxFor(req);
      const r = reviewRow(s, (req.params as any).review_id);
      const b = req.body as any;
      if (b.review_type_id && !db.get('SELECT 1 FROM review_types WHERE id = ? AND project_id = ?', [b.review_type_id, a.project.id])) {
        throw badRequest('Unknown review_type_id.');
      }
      if (b.reviewer_id && !isMember(ctx, a.project.id, b.reviewer_id)) throw badRequest('Reviewer must be a project member.');
      ctx.tx(() => {
        db.update('reviews', r.id, {
          ...(b.review_type_id ? { review_type_id: b.review_type_id } : {}),
          ...(b.reviewer_id !== undefined ? { reviewer_id: b.reviewer_id } : {}),
          ...(b.status ? { status: b.status } : {}),
          updated_at: now(),
        });
        touch(ctx, s);
        const after = reviewRow(s, r.id);
        const verb = b.status && b.status !== r.status ? `set ${after.review_type_name} review to ${b.status.replace('_', ' ')}` : `edited ${after.review_type_name} review`;
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'review_update_activity',
          highlight: verb,
          message: `${verb} on "${s.name}"`,
          changes: [{ kind: 'review', change_type: 'update', id: r.id, original_values: { status: r.status, reviewer_id: r.reviewer_id }, new_values: b }],
          primary_resources: res(ctx, s),
          story_ids: [s.id],
        });
        if (b.reviewer_id && b.reviewer_id !== r.reviewer_id) {
          notify(ctx, {
            user_ids: [b.reviewer_id],
            performer: u,
            project_id: a.project.id,
            story_id: s.id,
            notification_type: 'review_requested',
            message: `${u.name} requested your ${after.review_type_name} review on "${s.name}"`,
          });
        }
        if (b.status && b.status !== r.status && (b.status === 'pass' || b.status === 'revise')) {
          const owners = db.all<{ user_id: number }>('SELECT user_id FROM story_owners WHERE story_id = ?', [s.id]).map((o) => o.user_id);
          notify(ctx, {
            user_ids: owners,
            performer: u,
            project_id: a.project.id,
            story_id: s.id,
            notification_type: `review_${b.status}`,
            message: `${u.name} ${b.status === 'pass' ? 'passed' : 'requested revisions on'} the ${after.review_type_name} review of "${s.name}"`,
          });
        }
      });
      return reviewJson(reviewRow(s, r.id));
    },
  );

  app.delete(
    '/projects/:project_id/stories/:story_id/reviews/:review_id',
    { schema: { tags: ['Reviews'], summary: 'Delete a review', params: ReviewParams, response: { 200: ref(Ok) } } },
    async (req) => {
      const { u, a, s } = ctxFor(req);
      const r = reviewRow(s, (req.params as any).review_id);
      ctx.tx(() => {
        db.run('DELETE FROM reviews WHERE id = ?', [r.id]);
        touch(ctx, s);
        recordActivity(ctx, {
          project_id: a.project.id,
          performer: u,
          kind: 'review_delete_activity',
          highlight: 'removed review:',
          message: `removed ${r.review_type_name} review from "${s.name}"`,
          changes: [{ kind: 'review', change_type: 'delete', id: r.id }],
          primary_resources: res(ctx, s),
          story_ids: [s.id],
        });
      });
      return { ok: true };
    },
  );
}
