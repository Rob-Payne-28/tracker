import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { paginate, requireUser } from '../app.js';
import { ref, ProjectParams, Pagination } from '../schemas.js';
import { access, planFor, projectJson, type Project } from '../services/projects.js';
import { createStory, hydrate, storyRows, storyRowsByIds, type StoryRow } from '../services/stories.js';
import { searchStories } from '../services/search.js';
import { listActivities, recordActivity } from '../services/activity.js';
import { storyPoints } from '../lib/iterations.js';
import { localDate } from '../lib/dates.js';
import { parseCsv, toCsv } from '../lib/csv.js';
import { badRequest } from '../lib/errors.js';
import { epicJson } from './projects.js';
import type { Ctx } from '../services/context.js';

function iterationsJson(ctx: Ctx, project: Project, iterations: ReturnType<typeof planFor>['iterations'], withStories: boolean) {
  const all = withStories ? new Map(hydrate(ctx, storyRowsByIds(ctx, iterations.flatMap((i) => i.story_ids))).map((s) => [s.id, s])) : null;
  return iterations.map((it) => ({
    kind: 'iteration',
    project_id: project.id,
    ...it,
    ...(all ? { stories: it.story_ids.map((id) => all.get(id)!).filter(Boolean) } : {}),
  }));
}

export async function planningRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const db = ctx.db;
  const pid = (req: any) => Number(req.params.project_id);

  app.get(
    '/projects/:project_id/iterations',
    {
      schema: {
        tags: ['Iterations'],
        summary: 'List iterations',
        description: `Iterations computed from velocity.

* \`done\`: completed iterations (accepted stories, bucketed by acceptance date). \`limit\`/\`offset\` count back from the most recent.
* \`current\`: the iteration containing today: accepted-this-iteration, in-progress, then as many unstarted stories as fit.
* \`backlog\`: future iterations projected by velocity (or by planned_iteration_number when automatic planning is off).
* \`current_backlog\`: both.

Pass \`velocity\` to see "what if" projections.`,
        params: ProjectParams,
        querystring: Type.Composite([
          Pagination,
          Type.Object({
            scope: Type.Optional(
              Type.Union(['done', 'current', 'backlog', 'current_backlog', 'all'].map((v) => Type.Literal(v)), { default: 'current_backlog' }),
            ),
            velocity: Type.Optional(Type.Integer({ minimum: 1, description: 'Override velocity for projection' })),
            include_stories: Type.Optional(Type.Boolean({ default: true })),
          }),
        ]),
        response: { 200: Type.Array(ref('Iteration')) },
      },
    },
    async (req, reply) => {
      const a = access(ctx, pid(req), req.user, 'viewer');
      const q = req.query as any;
      const plan = planFor(ctx, a.project, { velocity: q.velocity });
      const scope = q.scope ?? 'current_backlog';
      let its = plan.iterations.filter((i) => {
        if (scope === 'all') return true;
        if (scope === 'current_backlog') return i.scope !== 'done';
        return i.scope === scope;
      });
      if (scope === 'done') {
        const limit = q.limit ?? 10;
        const offset = q.offset ?? 0;
        const total = its.length;
        its = its.slice(Math.max(0, total - offset - limit), total - offset).reverse();
        paginate(reply, total, limit, offset, its.length);
      }
      return iterationsJson(ctx, a.project, its, q.include_stories !== false);
    },
  );

  app.get(
    '/projects/:project_id/board',
    {
      schema: {
        tags: ['Iterations'],
        summary: 'Board snapshot',
        description:
          'Everything needed to render the planning board in one request: project, current + backlog iterations (story ids), icebox ids, release projections, and all referenced stories. Done iterations are fetched separately via /iterations?scope=done.',
        params: ProjectParams,
        querystring: Type.Object({ velocity: Type.Optional(Type.Integer({ minimum: 1 })) }),
        response: {
          200: Type.Object({
            project: ref('Project'),
            velocity: Type.Integer(),
            current_iteration_number: Type.Integer(),
            iterations: Type.Array(ref('Iteration')),
            icebox_ids: Type.Array(Type.Integer()),
            unplanned_ids: Type.Array(Type.Integer()),
            releases: Type.Array(ref('ReleaseProjection')),
            stories: Type.Array(ref('Story')),
            done_iteration_count: Type.Integer(),
          }),
        },
      },
    },
    async (req) => {
      const a = access(ctx, pid(req), req.user, 'viewer');
      const plan = planFor(ctx, a.project, { velocity: (req.query as any).velocity });
      const live = plan.iterations.filter((i) => i.scope !== 'done');
      const ids = [...live.flatMap((i) => i.story_ids), ...plan.icebox_ids, ...plan.unplanned_ids];
      if (req.user) db.run('UPDATE memberships SET last_viewed_at = ? WHERE project_id = ? AND user_id = ?', [new Date().toISOString(), a.project.id, req.user.id]);
      return {
        project: projectJson(ctx, a.project, a.role, plan),
        velocity: plan.velocity,
        current_iteration_number: plan.current_iteration_number,
        iterations: iterationsJson(ctx, a.project, live, false),
        icebox_ids: plan.icebox_ids,
        unplanned_ids: plan.unplanned_ids,
        releases: plan.releases,
        stories: hydrate(ctx, storyRowsByIds(ctx, ids)),
        done_iteration_count: plan.iterations.filter((i) => i.scope === 'done').length,
      };
    },
  );

  app.get(
    '/projects/:project_id/search',
    {
      schema: {
        tags: ['Search'],
        summary: 'Search stories and epics',
        description:
          'Full query language: free text, "phrases", label:, type:, state:, owner:, requester:, follower:, reviewer:, mywork:, id:, estimate:, epic:, is:, has:, name:, description:, created_since:/created_before:, updated_since:/updated_before:, accepted_since:/accepted_before:, includedone:true. Prefix a filter with "-" to negate. Accepted stories are excluded unless includedone:true (or the query asks for them).',
        params: ProjectParams,
        querystring: Type.Object({ query: Type.String({ minLength: 1 }) }),
        response: {
          200: Type.Object({
            query: Type.String(),
            stories: Type.Array(ref('Story')),
            epics: Type.Array(ref('Epic')),
            total_hits: Type.Integer(),
            total_points: Type.Number(),
            total_points_completed: Type.Number(),
          }),
        },
      },
    },
    async (req) => {
      const a = access(ctx, pid(req), req.user, 'viewer');
      const query = (req.query as any).query as string;
      const stories = searchStories(ctx, a.project, query, req.user?.id ?? null);
      const words = query
        .replace(/-?[a-z_]+:("[^"]*"|\S+)/gi, '')
        .trim()
        .toLowerCase();
      const epics = words
        ? db
            .all('SELECT * FROM epics WHERE project_id = ? AND (instr(lower(name), ?) > 0 OR instr(lower(description), ?) > 0) ORDER BY position', [
              a.project.id,
              words,
              words,
            ])
            .map((e) => epicJson(ctx, e))
        : [];
      const pts = (s: any) => storyPoints(s, a.project);
      return {
        query,
        stories,
        epics,
        total_hits: stories.length + epics.length,
        total_points: stories.reduce((n, s) => n + pts(s), 0),
        total_points_completed: stories.filter((s) => s.current_state === 'accepted').reduce((n, s) => n + pts(s), 0),
      };
    },
  );

  app.get(
    '/projects/:project_id/activity',
    {
      schema: {
        tags: ['Activity'],
        summary: 'Project history',
        description: 'Newest first. Use `since_version` to fetch only changes after a known project version (useful for syncing).',
        params: ProjectParams,
        querystring: Type.Composite([
          Pagination,
          Type.Object({
            since_version: Type.Optional(Type.Integer()),
            occurred_after: Type.Optional(Type.String()),
            occurred_before: Type.Optional(Type.String()),
            kind: Type.Optional(Type.String({ description: 'Filter by activity kind, e.g. story_update_activity' })),
          }),
        ]),
        response: { 200: Type.Array(ref('Activity')) },
      },
    },
    async (req, reply) => {
      const a = access(ctx, pid(req), req.user, 'viewer');
      const q = req.query as any;
      const where = ['a.project_id = ?'];
      const params: any[] = [a.project.id];
      if (q.since_version != null) where.push('a.project_version > ?') && params.push(q.since_version);
      if (q.occurred_after) where.push('a.occurred_at > ?') && params.push(q.occurred_after);
      if (q.occurred_before) where.push('a.occurred_at < ?') && params.push(q.occurred_before);
      if (q.kind) where.push('a.kind = ?') && params.push(q.kind);
      const limit = q.limit ?? 100;
      const offset = q.offset ?? 0;
      const { items, total } = listActivities(ctx, where.join(' AND '), params, limit, offset);
      paginate(reply, total, limit, offset, items.length);
      return items;
    },
  );

  // ------------------------------------------------------------------ Analytics
  app.get(
    '/projects/:project_id/analytics',
    {
      schema: {
        tags: ['Analytics'],
        summary: 'Project analytics',
        description:
          'Per-iteration velocity, burn-up (cumulative accepted points vs. scope), story type mix, rejection counts and cycle time, plus current iteration breakdown. Scope for burn-up counts estimated stories outside the icebox that existed at the end of each iteration.',
        params: ProjectParams,
        querystring: Type.Object({ iterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 20 })) }),
        response: {
          200: Type.Object({
            velocity: Type.Integer(),
            current_iteration_number: Type.Integer(),
            iterations: Type.Array(
              Type.Object({
                number: Type.Integer(),
                start: Type.String(),
                finish: Type.String(),
                scope: Type.String(),
                team_strength: Type.Number(),
                points_accepted: Type.Number(),
                rolling_velocity: Type.Number(),
                cumulative_points_accepted: Type.Number(),
                scope_points: Type.Number(),
                stories_accepted: Type.Integer(),
                features_accepted: Type.Integer(),
                bugs_accepted: Type.Integer(),
                chores_accepted: Type.Integer(),
                rejections: Type.Integer(),
                avg_cycle_time_hours: Type.Union([Type.Number(), Type.Null()]),
              }),
            ),
            current: Type.Object({
              points_total: Type.Number(),
              points_accepted: Type.Number(),
              state_counts: Type.Object({}, { additionalProperties: true }),
              state_points: Type.Object({}, { additionalProperties: true }),
            }),
            backlog_points: Type.Number(),
            icebox_points: Type.Number(),
            unestimated_features: Type.Integer(),
            cycle_times: Type.Array(
              Type.Object({
                story_id: Type.Integer(),
                name: Type.String(),
                story_type: Type.String(),
                estimate: Type.Union([Type.Number(), Type.Null()]),
                started_at: Type.String(),
                accepted_at: Type.String(),
                hours: Type.Number(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const a = access(ctx, pid(req), req.user, 'viewer');
      const p = a.project;
      const plan = planFor(ctx, p);
      const rows = storyRows(ctx, p.id);
      const pts = (s: StoryRow) => storyPoints(s, p);
      // Stories created directly as accepted (imports) have no meaningful cycle time.
      const hasCycle = (s: StoryRow) => !!s.started_at && !!s.accepted_at && Date.parse(s.accepted_at) > Date.parse(s.started_at);
      const tz = p.time_zone;
      const transitions = db.all("SELECT story_id, occurred_at FROM story_transitions WHERE project_id = ? AND state = 'rejected'", [p.id]);
      const limit = (req.query as any).iterations ?? 20;
      const relevant = plan.iterations.filter((i) => i.scope !== 'backlog');
      const normalised: number[] = [];
      let cumulative = 0;
      const byIt = relevant.map((it) => {
        const accepted = rows.filter((s) => it.story_ids.includes(s.id) && s.current_state === 'accepted');
        const points = accepted.reduce((n, s) => n + pts(s), 0);
        cumulative += points;
        if (it.scope === 'done' && it.team_strength > 0) normalised.push((points / it.team_strength) * (p.iteration_length / it.length));
        const recent = normalised.slice(-p.velocity_averaged_over);
        const cycles = accepted.filter(hasCycle).map((s) => (Date.parse(s.accepted_at!) - Date.parse(s.started_at!)) / 3600_000);
        const finish = it.finish;
        return {
          number: it.number,
          start: it.start,
          finish: it.finish,
          scope: it.scope,
          team_strength: it.team_strength,
          points_accepted: points,
          rolling_velocity: recent.length ? Math.round((recent.reduce((x, y) => x + y, 0) / recent.length) * 10) / 10 : p.initial_velocity,
          cumulative_points_accepted: cumulative,
          scope_points: rows
            .filter(
              (s) =>
                // Anything accepted by then was in scope, even if it was created (e.g. imported) later.
                (s.accepted_at && localDate(s.accepted_at, tz) < finish) ||
                (localDate(s.created_at, tz) < finish && s.current_state !== 'unscheduled'),
            )
            .reduce((n, s) => n + pts(s), 0),
          stories_accepted: accepted.length,
          features_accepted: accepted.filter((s) => s.story_type === 'feature').length,
          bugs_accepted: accepted.filter((s) => s.story_type === 'bug').length,
          chores_accepted: accepted.filter((s) => s.story_type === 'chore').length,
          rejections: transitions.filter((t) => {
            const d = localDate(t.occurred_at, tz);
            return d >= it.start && d < it.finish;
          }).length,
          avg_cycle_time_hours: cycles.length ? Math.round((cycles.reduce((x, y) => x + y, 0) / cycles.length) * 10) / 10 : null,
        };
      });
      const current = plan.iterations.find((i) => i.scope === 'current')!;
      const curStories = rows.filter((s) => current.story_ids.includes(s.id));
      const state_counts: Record<string, number> = {};
      const state_points: Record<string, number> = {};
      for (const s of curStories) {
        state_counts[s.current_state] = (state_counts[s.current_state] ?? 0) + 1;
        state_points[s.current_state] = (state_points[s.current_state] ?? 0) + pts(s);
      }
      const backlogIds = new Set(plan.iterations.filter((i) => i.scope === 'backlog').flatMap((i) => i.story_ids).concat(plan.unplanned_ids));
      const cycle_times = rows
        .filter((s) => s.current_state === 'accepted' && hasCycle(s))
        .sort((x, y) => y.accepted_at!.localeCompare(x.accepted_at!))
        .slice(0, 100)
        .map((s) => ({
          story_id: s.id,
          name: s.name,
          story_type: s.story_type,
          estimate: s.estimate,
          started_at: s.started_at!,
          accepted_at: s.accepted_at!,
          hours: Math.round(((Date.parse(s.accepted_at!) - Date.parse(s.started_at!)) / 3600_000) * 10) / 10,
        }));
      return {
        velocity: plan.velocity,
        current_iteration_number: plan.current_iteration_number,
        iterations: byIt.slice(-limit),
        current: { points_total: current.points, points_accepted: current.accepted_points, state_counts, state_points },
        backlog_points: rows.filter((s) => backlogIds.has(s.id)).reduce((n, s) => n + pts(s), 0),
        icebox_points: rows.filter((s) => s.current_state === 'unscheduled').reduce((n, s) => n + pts(s), 0),
        unestimated_features: rows.filter((s) => s.story_type === 'feature' && s.estimate == null && s.current_state !== 'accepted').length,
        cycle_times,
      };
    },
  );

  // ------------------------------------------------------------------ CSV export / import
  const HEADERS = ['Id', 'Title', 'Labels', 'Type', 'Estimate', 'Current State', 'Created at', 'Accepted at', 'Deadline', 'Requested By', 'Description', 'Owned By', 'Comment', 'Task', 'Task Status'];

  app.get(
    '/projects/:project_id/export.csv',
    {
      schema: {
        tags: ['Import & export'],
        summary: 'Export stories as CSV',
        description: 'One row per story in priority order. Multiple owners, comments and tasks appear as repeated columns.',
        params: ProjectParams,
        querystring: Type.Object({ include_done: Type.Optional(Type.Boolean({ default: true })), include_icebox: Type.Optional(Type.Boolean({ default: true })) }),
        produces: ['text/csv'],
        response: { 200: Type.String({ description: 'CSV' }) },
      },
    },
    async (req, reply) => {
      const a = access(ctx, pid(req), req.user, 'viewer');
      const q = req.query as any;
      let rows = storyRows(ctx, a.project.id);
      if (q.include_done === false) rows = rows.filter((s) => s.current_state !== 'accepted');
      if (q.include_icebox === false) rows = rows.filter((s) => s.current_state !== 'unscheduled');
      const people = new Map(db.all('SELECT id, name FROM users').map((u) => [u.id as number, u.name as string]));
      const data = rows.map((s) => {
        const labels = db.all('SELECT l.name FROM story_labels sl JOIN labels l ON l.id = sl.label_id WHERE sl.story_id = ? ORDER BY l.name', [s.id]).map((l) => l.name);
        const owners = db.all('SELECT user_id FROM story_owners WHERE story_id = ? ORDER BY position', [s.id]).map((o) => people.get(o.user_id) ?? '');
        const comments = db
          .all('SELECT text, person_id, created_at FROM comments WHERE story_id = ? ORDER BY id', [s.id])
          .map((c) => `${c.text} (${people.get(c.person_id) ?? 'Unknown'} - ${c.created_at})`);
        const tasks = db.all('SELECT description, complete FROM tasks WHERE story_id = ? ORDER BY position', [s.id]);
        return { s, labels, owners, comments, tasks };
      });
      const maxO = Math.max(1, ...data.map((d) => d.owners.length));
      const maxC = Math.max(1, ...data.map((d) => d.comments.length));
      const maxT = Math.max(1, ...data.map((d) => d.tasks.length));
      const header = [
        ...HEADERS.slice(0, 11),
        ...Array.from({ length: maxO }, () => 'Owned By'),
        ...Array.from({ length: maxC }, () => 'Comment'),
        ...Array.from({ length: maxT }, () => ['Task', 'Task Status']).flat(),
      ];
      const pad = <T>(arr: T[], n: number, fill: T) => [...arr, ...Array(Math.max(0, n - arr.length)).fill(fill)];
      const out = [
        header,
        ...data.map(({ s, labels, owners, comments, tasks }) => [
          s.id,
          s.name,
          labels.join(', '),
          s.story_type,
          s.estimate ?? '',
          s.current_state,
          s.created_at,
          s.accepted_at ?? '',
          s.deadline ?? '',
          s.requested_by_id ? (people.get(s.requested_by_id) ?? '') : '',
          s.description,
          ...pad(owners, maxO, ''),
          ...pad(comments, maxC, ''),
          ...pad(tasks, maxT, null).flatMap((t) => (t ? [t.description, t.complete ? 'completed' : 'not completed'] : ['', ''])),
        ]),
      ];
      const safe = a.project.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${safe}_${localDate(new Date(), a.project.time_zone)}.csv"`);
      return '﻿' + toCsv(out);
    },
  );

  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) => done(null, { csv: body }));

  app.post(
    '/projects/:project_id/import',
    {
      schema: {
        tags: ['Import & export'],
        summary: 'Import stories from CSV',
        description:
          'Send CSV as `text/csv`, or JSON `{ "csv": "..." }`. Recognised columns (case-insensitive): Title (required), Type, Estimate, Current State, Labels, Description, Requested By, Owned By (repeatable), Deadline, Accepted at, Created at, Comment (repeatable), Task + Task Status (repeatable). People are matched by name, username or email among project members. Ids are ignored; stories are appended in file order. Compatible with exports from this server and other trackers using the same column names.',
        params: ProjectParams,
        consumes: ['text/csv', 'application/json'],
        body: Type.Object({ csv: Type.String() }),
        response: { 200: Type.Object({ imported: Type.Integer(), errors: Type.Array(Type.Object({ row: Type.Integer(), error: Type.String() })) }) },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, pid(req), u, 'member');
      const rows = parseCsv((req.body as any).csv);
      if (rows.length < 2) throw badRequest('CSV must contain a header row and at least one story.');
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const col = (name: string) => header.indexOf(name);
      const cols = (name: string) => header.map((h, i) => (h === name ? i : -1)).filter((i) => i >= 0);
      if (col('title') < 0) throw badRequest('CSV needs a "Title" column.');
      const members = db.all(
        'SELECT u.id, lower(u.name) AS name, lower(u.username) AS username, lower(u.email) AS email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.project_id = ?',
        [a.project.id],
      );
      const person = (v: string) => {
        const s = v.trim().toLowerCase();
        return s ? (members.find((m) => m.name === s || m.username === s || m.email === s)?.id as number | undefined) : undefined;
      };
      const unescape = (v: string) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);
      const errors: { row: number; error: string }[] = [];
      let imported = 0;
      ctx.tx(() => {
        rows.slice(1).forEach((r, idx) => {
          const get = (name: string) => (col(name) >= 0 ? unescape(r[col(name)] ?? '').trim() : '');
          try {
            ctx.tx(() => {
              const type = (get('type') || 'feature').toLowerCase() as any;
              let state = (get('current state') || 'unscheduled').toLowerCase() as any;
              const est = get('estimate');
              const tIdx = cols('task');
              const sIdx = cols('task status');
              const row = createStory(
                ctx,
                a,
                u,
                {
                  name: get('title'),
                  description: get('description'),
                  story_type: type,
                  current_state: state,
                  estimate: est === '' || est === '-1' ? null : Number(est),
                  labels: get('labels').split(',').map((l) => l.trim()).filter(Boolean),
                  requested_by_id: person(get('requested by')) ?? u.id,
                  owner_ids: cols('owned by').map((i) => person(r[i] ?? '')).filter((x): x is number => !!x),
                  deadline: get('deadline') || null,
                  accepted_at: state === 'accepted' && get('accepted at') ? new Date(get('accepted at')).toISOString() : undefined,
                  tasks: tIdx
                    .map((ti, k) => ({ description: unescape(r[ti] ?? '').trim(), complete: (r[sIdx[k]] ?? '').trim().toLowerCase() === 'completed' }))
                    .filter((t) => t.description),
                },
                { silent: true },
              );
              const created = get('created at');
              if (created && !Number.isNaN(Date.parse(created))) db.run('UPDATE stories SET created_at = ? WHERE id = ?', [new Date(created).toISOString(), row.id]);
              for (const ci of cols('comment')) {
                const text = unescape(r[ci] ?? '').trim();
                if (!text) continue;
                const ts = new Date().toISOString();
                db.insert('comments', { project_id: a.project.id, story_id: row.id, person_id: u.id, text, created_at: ts, updated_at: ts });
              }
            });
            imported++;
          } catch (e: any) {
            errors.push({ row: idx + 2, error: e.message ?? String(e) });
          }
        });
        // One summary activity rather than one per story.
        if (imported) {
          recordActivity(ctx, {
            project_id: a.project.id,
            performer: u,
            kind: 'story_import_activity',
            highlight: 'imported',
            message: `imported ${imported} stor${imported === 1 ? 'y' : 'ies'} from CSV`,
          });
        }
      });
      return { imported, errors };
    },
  );
}
