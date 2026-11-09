import type { Ctx } from './context.js';
import type { User } from './people.js';
import { personJson } from './people.js';
import type { Row } from '../db/index.js';
import { now } from '../db/index.js';

export interface Change {
  kind: string;
  change_type: 'create' | 'update' | 'delete';
  id: number;
  name?: string;
  story_type?: string;
  original_values?: Record<string, unknown>;
  new_values?: Record<string, unknown>;
}

export interface PrimaryResource {
  kind: string;
  id: number;
  name: string;
  story_type?: string;
  url?: string;
}

export interface ActivityInput {
  project_id: number;
  performer: Pick<User, 'id' | 'name'> | null;
  kind: string;
  highlight: string;
  /** Message without the actor; the actor's name is prepended. */
  message: string;
  changes?: Change[];
  primary_resources?: PrimaryResource[];
  story_ids?: number[];
}

export function storyUrl(ctx: Ctx, projectId: number, storyId: number) {
  return `${ctx.config.baseUrl}/projects/${projectId}/stories/${storyId}`;
}

/** Record an activity entry, bump the project version, and (after commit) broadcast + deliver webhooks. */
export function recordActivity(ctx: Ctx, input: ActivityInput) {
  const db = ctx.db;
  db.run('UPDATE projects SET version = version + 1 WHERE id = ?', [input.project_id]);
  const version = db.get<{ version: number }>('SELECT version FROM projects WHERE id = ?', [input.project_id])!.version;
  const actor = input.performer?.name ?? 'Someone';
  const occurred_at = now();
  const id = db.insert('activities', {
    project_id: input.project_id,
    project_version: version,
    performed_by_id: input.performer?.id ?? null,
    kind: input.kind,
    highlight: input.highlight,
    message: `${actor} ${input.message}`,
    changes: JSON.stringify(input.changes ?? []),
    primary_resources: JSON.stringify(input.primary_resources ?? []),
    occurred_at,
  });
  for (const sid of new Set(input.story_ids ?? [])) {
    db.run('INSERT OR IGNORE INTO activity_stories (activity_id, story_id) VALUES (?, ?)', [id, sid]);
  }
  const activity = activityJson(ctx, db.get('SELECT * FROM activities WHERE id = ?', [id])!);
  // Fan out to every registered sink (realtime stream, webhooks, …) once the transaction commits.
  ctx.afterCommit(() => ctx.emitActivity(input.project_id, activity));
  return activity;
}

export type ActivityJson = ReturnType<typeof activityJson>;

export function activityJson(ctx: Ctx, a: Row, people?: Map<number, Row>, projects?: Map<number, Row>) {
  const performer = a.performed_by_id
    ? (people?.get(a.performed_by_id) ??
      ctx.db.get('SELECT id, name, email, initials, username FROM users WHERE id = ?', [a.performed_by_id]))
    : null;
  const project =
    projects?.get(a.project_id) ?? ctx.db.get('SELECT id, name FROM projects WHERE id = ?', [a.project_id]);
  return {
    kind: a.kind,
    guid: `${a.project_id}_${a.project_version}`,
    id: a.id as number,
    project_version: a.project_version as number,
    message: a.message as string,
    highlight: a.highlight as string,
    changes: JSON.parse(a.changes),
    primary_resources: JSON.parse(a.primary_resources),
    project: { kind: 'project', id: a.project_id as number, name: (project?.name as string) ?? '' },
    performed_by: performer ? personJson(performer as any) : null,
    occurred_at: a.occurred_at as string,
  };
}

export function listActivities(ctx: Ctx, where: string, params: any[], limit: number, offset: number) {
  const rows = ctx.db.all(`SELECT a.* FROM activities a WHERE ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities a WHERE ${where}`, params)!.n;
  const people = new Map<number, Row>();
  const ids = [...new Set(rows.map((r) => r.performed_by_id).filter(Boolean))];
  if (ids.length) {
    for (const p of ctx.db.all('SELECT id, name, email, initials, username FROM users WHERE id IN (SELECT value FROM json_each(?))', [
      JSON.stringify(ids),
    ]))
      people.set(p.id, p);
  }
  return { items: rows.map((r) => activityJson(ctx, r, people)), total };
}

// ---------------------------------------------------------------------------------------------
// Notifications

export interface NotifyInput {
  user_ids: number[];
  performer: Pick<User, 'id' | 'name'> | null;
  project_id: number;
  story_id?: number | null;
  epic_id?: number | null;
  notification_type: string;
  message: string;
  context?: string | null;
}

export function notify(ctx: Ctx, input: NotifyInput) {
  const recipients = [...new Set(input.user_ids)].filter((id) => id && id !== input.performer?.id);
  for (const user_id of recipients) {
    const id = ctx.db.insert('notifications', {
      user_id,
      performer_id: input.performer?.id ?? null,
      project_id: input.project_id,
      story_id: input.story_id ?? null,
      epic_id: input.epic_id ?? null,
      notification_type: input.notification_type,
      message: input.message,
      context: input.context ?? null,
      created_at: now(),
    });
    const row = ctx.db.get('SELECT * FROM notifications WHERE id = ?', [id])!;
    const json = notificationJson(ctx, row);
    const user = ctx.db.get<{ email: string; email_notifications: number; is_active: number }>(
      'SELECT email, email_notifications, is_active FROM users WHERE id = ?',
      [user_id],
    );
    ctx.afterCommit(() => {
      ctx.events.publish(`user:${user_id}`, { type: 'notification', user_id, data: json });
      if (user && user.email_notifications && user.is_active && ctx.mailer.enabled) {
        const link = input.story_id ? `\n\n${storyUrl(ctx, input.project_id, input.story_id)}` : '';
        const ctxText = input.context ? `\n\n${input.context}` : '';
        void ctx.mailer.send(user.email, `[Tracker] ${input.message}`, `${input.message}${ctxText}${link}`);
      }
    });
  }
}

export function notificationJson(ctx: Ctx, n: Row) {
  const performer = n.performer_id
    ? ctx.db.get('SELECT id, name, email, initials, username FROM users WHERE id = ?', [n.performer_id])
    : null;
  const project = n.project_id ? ctx.db.get('SELECT id, name FROM projects WHERE id = ?', [n.project_id]) : null;
  const story = n.story_id ? ctx.db.get('SELECT id, name, story_type FROM stories WHERE id = ?', [n.story_id]) : null;
  return {
    kind: 'notification',
    id: n.id as number,
    notification_type: n.notification_type as string,
    message: n.message as string,
    context: (n.context as string) ?? null,
    performer: performer ? personJson(performer as any) : null,
    project: project ? { kind: 'project', id: project.id as number, name: project.name as string } : null,
    story: story ? { kind: 'story', id: story.id as number, name: story.name as string, story_type: story.story_type as string } : null,
    epic_id: (n.epic_id as number) ?? null,
    read_at: (n.read_at as string) ?? null,
    created_at: n.created_at as string,
  };
}

/** Find @mentioned project members in a piece of text. */
export function mentionedUserIds(ctx: Ctx, projectId: number, text: string): number[] {
  const names = [...text.matchAll(/(?:^|[^\w@])@([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
  if (!names.length) return [];
  return ctx.db
    .all(
      `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id AND m.project_id = ?
        WHERE lower(u.username) IN (SELECT value FROM json_each(?))`,
      [projectId, JSON.stringify(names)],
    )
    .map((r) => r.id as number);
}
