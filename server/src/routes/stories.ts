import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { paginate, requireUser } from '../app.js';
import { ref, Ok, StoryCreate, StoryUpdate, ProjectParams, StoryParams, StoryStateEnum, StoryTypeEnum, Pagination, Nullable } from '../schemas.js';
import { access } from '../services/projects.js';
import {
  createStory,
  deleteStory,
  getStoryRow,
  hydrate,
  storyFull,
  storyRows,
  updateStory,
  findOrCreateLabel,
  type StoryInput,
} from '../services/stories.js';
import { searchStories } from '../services/search.js';
import { listActivities, recordActivity } from '../services/activity.js';
import { badRequest } from '../lib/errors.js';
import { now } from '../db/index.js';

export async function storyRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const db = ctx.db;
  const pid = (req: any) => Number(req.params.project_id);
  const sid = (req: any) => Number(req.params.story_id);

  app.get(
    '/projects/:project_id/stories',
    {
      schema: {
        tags: ['Stories'],
        summary: 'List stories',
        description:
          'Stories in priority order. Combine filters freely. `filter` accepts the full search query language (see the Search section of the docs), e.g. `label:ui state:started owner:me`.',
        params: ProjectParams,
        querystring: Type.Composite([
          Pagination,
          Type.Object({
            with_state: Type.Optional(StoryStateEnum),
            with_story_type: Type.Optional(StoryTypeEnum),
            with_label: Type.Optional(Type.String({ description: 'Label name' })),
            ids: Type.Optional(Type.String({ description: 'Comma separated story ids' })),
            filter: Type.Optional(Type.String({ description: 'Search query' })),
            created_after: Type.Optional(Type.String()),
            updated_after: Type.Optional(Type.String()),
            accepted_after: Type.Optional(Type.String()),
            accepted_before: Type.Optional(Type.String()),
          }),
        ]),
        response: { 200: Type.Array(ref('Story')) },
      },
    },
    async (req, reply) => {
      const a = access(ctx, pid(req), req.user, 'viewer');
      const q = req.query as any;
      const limit = q.limit ?? 100;
      const offset = q.offset ?? 0;
      let stories;
      if (q.filter) stories = searchStories(ctx, a.project, q.filter, req.user?.id ?? null);
      else stories = hydrate(ctx, storyRows(ctx, a.project.id));
      if (q.with_state) stories = stories.filter((s) => s.current_state === q.with_state);
      if (q.with_story_type) stories = stories.filter((s) => s.story_type === q.with_story_type);
      if (q.with_label) stories = stories.filter((s) => s.labels.some((l) => l.name.toLowerCase() === q.with_label.toLowerCase()));
      if (q.ids) {
        const set = new Set(String(q.ids).split(',').map(Number));
        stories = stories.filter((s) => set.has(s.id));
      }
      if (q.created_after) stories = stories.filter((s) => s.created_at > q.created_after);
      if (q.updated_after) stories = stories.filter((s) => s.updated_at > q.updated_after);
      if (q.accepted_after) stories = stories.filter((s) => s.accepted_at && s.accepted_at > q.accepted_after);
      if (q.accepted_before) stories = stories.filter((s) => s.accepted_at && s.accepted_at < q.accepted_before);
      const page = stories.slice(offset, offset + limit);
      paginate(reply, stories.length, limit, offset, page.length);
      return page;
    },
  );

  app.post(
    '/projects/:project_id/stories',
    {
      schema: {
        tags: ['Stories'],
        summary: 'Create a story',
        description:
          'Defaults: story_type `feature`, current_state `unscheduled` (icebox), requested_by = you. Without before_id/after_id, icebox stories go to the top of the icebox and other stories to the bottom of the backlog. Labels given by name are created if needed.',
        params: ProjectParams,
        body: StoryCreate,
        response: { 201: ref('StoryFull') },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const row = createStory(ctx, a, u, req.body as StoryInput);
      return reply.status(201).send(storyFull(ctx, row));
    },
  );

  app.get(
    '/projects/:project_id/stories/:story_id',
    { schema: { tags: ['Stories'], summary: 'Get a story', description: 'Includes tasks, comments, blockers and reviews.', params: StoryParams, response: { 200: ref('StoryFull') } } },
    async (req) => {
      access(ctx, pid(req), req.user, 'viewer');
      return storyFull(ctx, getStoryRow(ctx, sid(req), pid(req)));
    },
  );

  app.get(
    '/stories/:story_id',
    {
      schema: {
        tags: ['Stories'],
        summary: 'Get a story by id',
        description: 'Look up a story without knowing its project.',
        params: Type.Object({ story_id: Type.Integer() }),
        response: { 200: ref('StoryFull') },
      },
    },
    async (req) => {
      const row = getStoryRow(ctx, sid(req));
      access(ctx, row.project_id, req.user, 'viewer');
      return storyFull(ctx, row);
    },
  );

  app.put(
    '/projects/:project_id/stories/:story_id',
    {
      schema: {
        tags: ['Stories'],
        summary: 'Update a story',
        description: `Partial update. Notable behaviour:

* **State changes** enforce the workflow: unestimated features cannot be started; chores have no finished/delivered/rejected; releases only unstarted/accepted. Starting a story with no owners makes you the owner. Accepting sets \`accepted_at\`.
* **Prioritisation:** pass \`before_id\` or \`after_id\` to move the story. Move between icebox and backlog by also changing \`current_state\` (\`unscheduled\` ↔ \`unstarted\`).
* \`owner_ids\`, \`follower_ids\`, \`label_ids\`/\`labels\` replace the existing lists.
* Set \`project_id\` to move the story to another project.`,
        params: StoryParams,
        body: StoryUpdate,
        response: { 200: ref('StoryFull') },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const row = updateStory(ctx, a, u, sid(req), req.body as StoryInput);
      return storyFull(ctx, row);
    },
  );

  app.delete(
    '/projects/:project_id/stories/:story_id',
    { schema: { tags: ['Stories'], summary: 'Delete a story', params: StoryParams, response: { 200: ref(Ok) } } },
    async (req) => {
      const u = requireUser(req);
      deleteStory(ctx, access(ctx, pid(req), u, 'member'), u, sid(req));
      return { ok: true };
    },
  );

  app.post(
    '/projects/:project_id/stories/:story_id/clone',
    {
      schema: {
        tags: ['Stories'],
        summary: 'Clone a story',
        description: 'Copies name ("Copy of …"), description, type, estimate, labels and tasks into a new story placed directly after the original, in the same panel.',
        params: StoryParams,
        response: { 201: ref('StoryFull') },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const s = storyFull(ctx, getStoryRow(ctx, sid(req), a.project.id));
      const inProgress = !['unscheduled', 'unstarted', 'accepted'].includes(s.current_state);
      const row = createStory(ctx, a, u, {
        name: `Copy of ${s.name}`,
        description: s.description,
        story_type: s.story_type as any,
        current_state: s.current_state === 'unscheduled' ? 'unscheduled' : 'unstarted',
        estimate: s.estimate,
        label_ids: s.label_ids,
        deadline: s.deadline,
        after_id: inProgress || s.current_state === 'accepted' ? undefined : s.id,
        tasks: s.tasks.map((t) => ({ description: t.description, complete: false })),
      });
      return reply.status(201).send(storyFull(ctx, row));
    },
  );

  // ---- Follow / unfollow
  for (const method of ['post', 'delete'] as const) {
    app[method](
      '/projects/:project_id/stories/:story_id/follow',
      {
        schema: {
          tags: ['Stories'],
          summary: method === 'post' ? 'Follow a story' : 'Unfollow a story',
          description: 'Followers are notified about comments and state changes.',
          params: StoryParams,
          response: { 200: ref('StoryFull') },
        },
      },
      async (req) => {
        const u = requireUser(req);
        const a = access(ctx, pid(req), u, 'viewer');
        const s = getStoryRow(ctx, sid(req), a.project.id);
        if (method === 'post') db.run('INSERT OR IGNORE INTO story_followers (story_id, user_id) VALUES (?, ?)', [s.id, u.id]);
        else db.run('DELETE FROM story_followers WHERE story_id = ? AND user_id = ?', [s.id, u.id]);
        return storyFull(ctx, s);
      },
    );
  }

  // ---- Bulk operations
  app.put(
    '/projects/:project_id/stories/bulk',
    {
      schema: {
        tags: ['Stories'],
        summary: 'Update many stories',
        description:
          'Applies the same change to several stories (each change is validated individually; the whole request is atomic). `move` places the stories, in the given order, at the top/bottom of the backlog or icebox.',
        params: ProjectParams,
        body: Type.Object({
          story_ids: Type.Array(Type.Integer(), { minItems: 1, maxItems: 500 }),
          current_state: Type.Optional(StoryStateEnum),
          story_type: Type.Optional(StoryTypeEnum),
          estimate: Type.Optional(Nullable(Type.Number())),
          owner_ids: Type.Optional(Type.Array(Type.Integer())),
          requested_by_id: Type.Optional(Type.Integer()),
          add_labels: Type.Optional(Type.Array(Type.String())),
          remove_labels: Type.Optional(Type.Array(Type.String())),
          project_id: Type.Optional(Type.Integer({ description: 'Move all stories to another project' })),
          move: Type.Optional(
            Type.Union(['top_of_backlog', 'bottom_of_backlog', 'top_of_icebox', 'bottom_of_icebox'].map((v) => Type.Literal(v))),
          ),
        }),
        response: { 200: Type.Array(ref('Story')) },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const b = req.body as any;
      ctx.tx(() => {
        let anchor: number | null = null;
        for (const id of b.story_ids as number[]) {
          const s = getStoryRow(ctx, id, a.project.id);
          const input: StoryInput = {};
          for (const k of ['current_state', 'story_type', 'estimate', 'owner_ids', 'requested_by_id', 'project_id'] as const) {
            if (b[k] !== undefined) (input as any)[k] = b[k];
          }
          if (b.add_labels || b.remove_labels) {
            const current = db
              .all<{ name: string }>('SELECT l.name FROM story_labels sl JOIN labels l ON l.id = sl.label_id WHERE sl.story_id = ?', [s.id])
              .map((l) => l.name);
            const remove = new Set((b.remove_labels ?? []).map((n: string) => n.toLowerCase()));
            input.labels = [...current.filter((n) => !remove.has(n.toLowerCase())), ...(b.add_labels ?? [])];
          }
          if (b.move) {
            const icebox = b.move.endsWith('icebox');
            input.current_state = input.current_state ?? (icebox ? 'unscheduled' : s.current_state === 'unscheduled' ? 'unstarted' : undefined);
            if (anchor) input.after_id = anchor;
            else {
              const edge = db.get<{ id: number }>(
                `SELECT id FROM stories WHERE project_id = ? AND id NOT IN (SELECT value FROM json_each(?)) AND current_state ${icebox ? "= 'unscheduled'" : "NOT IN ('unscheduled','accepted')"}
                 ORDER BY position ${b.move.startsWith('top') ? 'ASC' : 'DESC'} LIMIT 1`,
                [a.project.id, JSON.stringify(b.story_ids)],
              );
              if (edge) {
                if (b.move.startsWith('top')) input.before_id = edge.id;
                else input.after_id = edge.id;
              }
            }
            anchor = id;
          }
          updateStory(ctx, a, u, id, input);
        }
      });
      const rows = db.all<any>('SELECT * FROM stories WHERE id IN (SELECT value FROM json_each(?)) ORDER BY position', [JSON.stringify(b.story_ids)]);
      return hydrate(ctx, rows);
    },
  );

  app.post(
    '/projects/:project_id/stories/bulk_delete',
    {
      schema: {
        tags: ['Stories'],
        summary: 'Delete many stories',
        params: ProjectParams,
        body: Type.Object({ story_ids: Type.Array(Type.Integer(), { minItems: 1, maxItems: 500 }) }),
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      ctx.tx(() => {
        for (const id of (req.body as any).story_ids) deleteStory(ctx, a, u, id);
      });
      return { ok: true };
    },
  );

  app.get(
    '/projects/:project_id/stories/:story_id/activity',
    {
      schema: {
        tags: ['Activity'],
        summary: 'Story history',
        params: StoryParams,
        querystring: Pagination,
        response: { 200: Type.Array(ref('Activity')) },
      },
    },
    async (req, reply) => {
      access(ctx, pid(req), req.user, 'viewer');
      getStoryRow(ctx, sid(req), pid(req));
      const q = req.query as any;
      const limit = q.limit ?? 100;
      const offset = q.offset ?? 0;
      const { items, total } = listActivities(ctx, 'a.id IN (SELECT activity_id FROM activity_stories WHERE story_id = ?)', [sid(req)], limit, offset);
      paginate(reply, total, limit, offset, items.length);
      return items;
    },
  );

  // ---- Label shortcuts on a story
  app.post(
    '/projects/:project_id/stories/:story_id/labels',
    {
      schema: {
        tags: ['Labels'],
        summary: 'Add a label to a story',
        params: StoryParams,
        body: Type.Object({ name: Type.String({ minLength: 1 }) }),
        response: { 200: ref('StoryFull') },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const s = getStoryRow(ctx, sid(req), a.project.id);
      const labels = db.all<{ label_id: number }>('SELECT label_id FROM story_labels WHERE story_id = ?', [s.id]).map((l) => l.label_id);
      const id = ctx.tx(() => findOrCreateLabel(ctx, a.project.id, (req.body as any).name.trim()));
      return storyFull(ctx, updateStory(ctx, a, u, s.id, { label_ids: [...labels, id] }));
    },
  );

  app.delete(
    '/projects/:project_id/stories/:story_id/labels/:label_id',
    {
      schema: {
        tags: ['Labels'],
        summary: 'Remove a label from a story',
        params: Type.Object({ project_id: Type.Integer(), story_id: Type.Integer(), label_id: Type.Integer() }),
        response: { 200: ref('StoryFull') },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const s = getStoryRow(ctx, sid(req), a.project.id);
      const labelId = Number((req.params as any).label_id);
      const labels = db.all<{ label_id: number }>('SELECT label_id FROM story_labels WHERE story_id = ?', [s.id]).map((l) => l.label_id);
      if (!labels.includes(labelId)) throw badRequest('Story does not have that label.');
      return storyFull(ctx, updateStory(ctx, a, u, s.id, { label_ids: labels.filter((l) => l !== labelId) }));
    },
  );

  void recordActivity;
  void now;
}
