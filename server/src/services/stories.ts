import type { Ctx } from './context.js';
import type { User } from './people.js';
import type { Access, Project } from './projects.js';
import { access as accessFor, isMember, pointScale } from './projects.js';
import { recordActivity, notify, mentionedUserIds, storyUrl, type Change } from './activity.js';
import { badRequest, notFound } from '../lib/errors.js';
import { now, type Row } from '../db/index.js';
import { isValidDate } from '../lib/dates.js';

export const STORY_TYPES = ['feature', 'bug', 'chore', 'release'] as const;
export const STORY_STATES = ['unscheduled', 'unstarted', 'started', 'finished', 'delivered', 'rejected', 'accepted'] as const;
export type StoryType = (typeof STORY_TYPES)[number];
export type StoryState = (typeof STORY_STATES)[number];

const ALLOWED_STATES: Record<StoryType, readonly StoryState[]> = {
  feature: STORY_STATES,
  bug: STORY_STATES,
  chore: ['unscheduled', 'unstarted', 'started', 'accepted'],
  release: ['unscheduled', 'unstarted', 'accepted'],
};
const STARTED_STATES = new Set(['started', 'finished', 'delivered', 'rejected', 'accepted']);

export interface StoryRow {
  id: number;
  project_id: number;
  name: string;
  description: string;
  story_type: StoryType;
  current_state: StoryState;
  estimate: number | null;
  position: number;
  requested_by_id: number | null;
  deadline: string | null;
  accepted_at: string | null;
  started_at: string | null;
  planned_iteration_number: number | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoryInput {
  name?: string;
  description?: string;
  story_type?: StoryType;
  current_state?: StoryState;
  estimate?: number | null;
  requested_by_id?: number | null;
  owner_ids?: number[];
  follower_ids?: number[];
  label_ids?: number[];
  labels?: (string | { id?: number; name?: string })[];
  deadline?: string | null;
  accepted_at?: string | null;
  planned_iteration_number?: number | null;
  external_id?: string | null;
  before_id?: number | null;
  after_id?: number | null;
  project_id?: number;
  tasks?: { description: string; complete?: boolean }[];
}

const ids = (list: number[]) => JSON.stringify([...new Set(list)]);

export function getStoryRow(ctx: Ctx, storyId: number, projectId?: number): StoryRow {
  const s = ctx.db.get<StoryRow>('SELECT * FROM stories WHERE id = ?', [storyId]);
  if (!s || (projectId !== undefined && s.project_id !== projectId)) throw notFound('Story');
  return s;
}

// ---------------------------------------------------------------------------------------------
// Serialization

export function hydrate(ctx: Ctx, rows: StoryRow[]) {
  if (!rows.length) return [];
  const db = ctx.db;
  const list = ids(rows.map((r) => r.id));
  const group = <T>(sql: string, key = 'story_id') => {
    const m = new Map<number, T[]>();
    for (const r of db.all(sql, [list])) {
      const k = r[key] as number;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r as T);
    }
    return m;
  };
  const owners = group<Row>(
    'SELECT story_id, user_id FROM story_owners WHERE story_id IN (SELECT value FROM json_each(?)) ORDER BY position, rowid',
  );
  const followers = group<Row>('SELECT story_id, user_id FROM story_followers WHERE story_id IN (SELECT value FROM json_each(?))');
  const labels = group<Row>(
    `SELECT sl.story_id, l.id, l.name, l.project_id FROM story_labels sl JOIN labels l ON l.id = sl.label_id
      WHERE sl.story_id IN (SELECT value FROM json_each(?)) ORDER BY l.name COLLATE NOCASE`,
  );
  const counts = (sql: string) => new Map(db.all(sql, [list]).map((r) => [r.story_id as number, r]));
  const tasks = counts(
    'SELECT story_id, COUNT(*) AS total, SUM(complete) AS done FROM tasks WHERE story_id IN (SELECT value FROM json_each(?)) GROUP BY story_id',
  );
  const comments = counts(
    `SELECT c.story_id, COUNT(DISTINCT c.id) AS n, COUNT(a.id) AS files FROM comments c LEFT JOIN attachments a ON a.comment_id = c.id
      WHERE c.story_id IN (SELECT value FROM json_each(?)) GROUP BY c.story_id`,
  );
  const reviews = counts(
    `SELECT story_id, COUNT(*) AS total, SUM(status = 'pass') AS passed FROM reviews WHERE story_id IN (SELECT value FROM json_each(?)) GROUP BY story_id`,
  );
  const blockers = group<Row>(
    'SELECT story_id, description FROM blockers WHERE resolved = 0 AND story_id IN (SELECT value FROM json_each(?))',
  );
  // Stories that these stories are blocking (unresolved blockers elsewhere referencing "#<id>").
  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  const blocking = new Map<number, number[]>();
  const refRows = db.all(
    `SELECT b.story_id, b.description FROM blockers b JOIN stories s ON s.id = b.story_id
      WHERE b.resolved = 0 AND b.description LIKE '%#%' AND s.project_id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(projectIds)],
  );
  for (const r of refRows) {
    for (const ref of storyRefs(r.description)) {
      if (!blocking.has(ref)) blocking.set(ref, []);
      blocking.get(ref)!.push(r.story_id);
    }
  }

  return rows.map((s) => {
    const t = tasks.get(s.id);
    const c = comments.get(s.id);
    const rv = reviews.get(s.id);
    const bl = blockers.get(s.id) ?? [];
    const lbls = (labels.get(s.id) ?? []).map((l) => ({ kind: 'label', id: l.id as number, project_id: l.project_id as number, name: l.name as string }));
    return {
      kind: 'story',
      id: s.id,
      project_id: s.project_id,
      name: s.name,
      description: s.description,
      story_type: s.story_type,
      current_state: s.current_state,
      estimate: s.estimate,
      position: s.position,
      requested_by_id: s.requested_by_id,
      owner_ids: (owners.get(s.id) ?? []).map((o) => o.user_id as number),
      follower_ids: (followers.get(s.id) ?? []).map((o) => o.user_id as number),
      label_ids: lbls.map((l) => l.id),
      labels: lbls,
      deadline: s.deadline,
      accepted_at: s.accepted_at,
      started_at: s.started_at,
      planned_iteration_number: s.planned_iteration_number,
      external_id: s.external_id,
      tasks_total: Number(t?.total ?? 0),
      tasks_completed: Number(t?.done ?? 0),
      comment_count: Number(c?.n ?? 0),
      attachment_count: Number(c?.files ?? 0),
      reviews_total: Number(rv?.total ?? 0),
      reviews_passed: Number(rv?.passed ?? 0),
      blocker_count: bl.length,
      blocked_by_story_ids: [...new Set(bl.flatMap((b) => storyRefs(b.description)))],
      blocking_story_ids: [...new Set(blocking.get(s.id) ?? [])],
      url: storyUrl(ctx, s.project_id, s.id),
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
  });
}

export type StoryJson = ReturnType<typeof hydrate>[number];

export function storyRefs(text: string): number[] {
  return [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

export function taskJson(t: Row) {
  return {
    kind: 'task',
    id: t.id as number,
    story_id: t.story_id as number,
    description: t.description as string,
    complete: !!t.complete,
    position: t.position as number,
    created_at: t.created_at as string,
    updated_at: t.updated_at as string,
  };
}

export function attachmentJson(ctx: Ctx, a: Row) {
  return {
    kind: 'file_attachment',
    id: a.id as number,
    project_id: a.project_id as number,
    comment_id: (a.comment_id as number) ?? null,
    uploader_id: (a.uploader_id as number) ?? null,
    filename: a.filename as string,
    content_type: a.content_type as string,
    size: a.size as number,
    download_url: `/api/v1/attachments/${a.id}/download`,
    created_at: a.created_at as string,
  };
}

export function commentsJson(ctx: Ctx, rows: Row[]) {
  if (!rows.length) return [];
  const files = new Map<number, Row[]>();
  for (const a of ctx.db.all('SELECT * FROM attachments WHERE comment_id IN (SELECT value FROM json_each(?)) ORDER BY id', [
    ids(rows.map((r) => r.id)),
  ])) {
    if (!files.has(a.comment_id)) files.set(a.comment_id, []);
    files.get(a.comment_id)!.push(a);
  }
  return rows.map((c) => ({
    kind: 'comment',
    id: c.id as number,
    project_id: c.project_id as number,
    story_id: (c.story_id as number) ?? null,
    epic_id: (c.epic_id as number) ?? null,
    person_id: (c.person_id as number) ?? null,
    text: c.text as string,
    commit_identifier: (c.commit_identifier as string) ?? null,
    commit_type: (c.commit_type as string) ?? null,
    file_attachments: (files.get(c.id) ?? []).map((a) => attachmentJson(ctx, a)),
    created_at: c.created_at as string,
    updated_at: c.updated_at as string,
  }));
}

export function blockerJson(b: Row) {
  return {
    kind: 'blocker',
    id: b.id as number,
    story_id: b.story_id as number,
    person_id: (b.person_id as number) ?? null,
    description: b.description as string,
    resolved: !!b.resolved,
    created_at: b.created_at as string,
    updated_at: b.updated_at as string,
  };
}

export function reviewJson(r: Row) {
  return {
    kind: 'review',
    id: r.id as number,
    story_id: r.story_id as number,
    review_type_id: r.review_type_id as number,
    review_type_name: (r.review_type_name as string) ?? '',
    reviewer_id: (r.reviewer_id as number) ?? null,
    status: r.status as string,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export function storyFull(ctx: Ctx, row: StoryRow) {
  const [base] = hydrate(ctx, [row]);
  const db = ctx.db;
  return {
    ...base,
    tasks: db.all('SELECT * FROM tasks WHERE story_id = ? ORDER BY position, id', [row.id]).map(taskJson),
    comments: commentsJson(ctx, db.all('SELECT * FROM comments WHERE story_id = ? ORDER BY id', [row.id])),
    blockers: db.all('SELECT * FROM blockers WHERE story_id = ? ORDER BY id', [row.id]).map(blockerJson),
    reviews: db
      .all(
        `SELECT r.*, rt.name AS review_type_name FROM reviews r JOIN review_types rt ON rt.id = r.review_type_id
          WHERE r.story_id = ? ORDER BY r.id`,
        [row.id],
      )
      .map(reviewJson),
  };
}

// ---------------------------------------------------------------------------------------------
// Prioritisation (fractional positions shared by every story in a project)

const GAP = 1024;

function renormalize(ctx: Ctx, projectId: number) {
  const rows = ctx.db.all<{ id: number }>('SELECT id FROM stories WHERE project_id = ? ORDER BY position, id', [projectId]);
  rows.forEach((r, i) => ctx.db.run('UPDATE stories SET position = ? WHERE id = ?', [(i + 1) * GAP, r.id]));
}

function between(ctx: Ctx, projectId: number, lo: number | null, hi: number | null, retry = true): number {
  if (lo == null && hi == null) return GAP;
  if (lo == null) return hi! - GAP;
  if (hi == null) return lo + GAP;
  if (hi - lo > 1e-6) return (lo + hi) / 2;
  if (!retry) return (lo + hi) / 2;
  renormalize(ctx, projectId);
  return NaN; // caller recomputes
}

/** Position immediately before `beforeId` (excluding the story being moved). */
export function positionBefore(ctx: Ctx, projectId: number, beforeId: number, movingId?: number): number {
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = ctx.db.get<{ position: number }>('SELECT position FROM stories WHERE id = ? AND project_id = ?', [beforeId, projectId]);
    if (!target) throw badRequest(`before_id ${beforeId} is not a story in this project.`);
    const prev = ctx.db.get<{ position: number }>(
      'SELECT position FROM stories WHERE project_id = ? AND position < ? AND id != ? ORDER BY position DESC LIMIT 1',
      [projectId, target.position, movingId ?? -1],
    );
    const p = between(ctx, projectId, prev?.position ?? null, target.position, attempt === 0);
    if (!Number.isNaN(p)) return p;
  }
  throw new Error('unreachable');
}

/** Position immediately after `afterId` (excluding the story being moved). */
export function positionAfter(ctx: Ctx, projectId: number, afterId: number, movingId?: number): number {
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = ctx.db.get<{ position: number }>('SELECT position FROM stories WHERE id = ? AND project_id = ?', [afterId, projectId]);
    if (!target) throw badRequest(`after_id ${afterId} is not a story in this project.`);
    const next = ctx.db.get<{ position: number }>(
      'SELECT position FROM stories WHERE project_id = ? AND position > ? AND id != ? ORDER BY position ASC LIMIT 1',
      [projectId, target.position, movingId ?? -1],
    );
    const p = between(ctx, projectId, target.position, next?.position ?? null, attempt === 0);
    if (!Number.isNaN(p)) return p;
  }
  throw new Error('unreachable');
}

function edgePosition(ctx: Ctx, projectId: number, where: string, edge: 'top' | 'bottom'): number {
  const r = ctx.db.get<{ p: number | null }>(
    `SELECT ${edge === 'top' ? 'MIN' : 'MAX'}(position) AS p FROM stories WHERE project_id = ? AND ${where}`,
    [projectId],
  );
  if (r?.p == null) {
    const any = ctx.db.get<{ p: number | null }>(`SELECT MAX(position) AS p FROM stories WHERE project_id = ?`, [projectId]);
    return (any?.p ?? 0) + GAP;
  }
  return edge === 'top' ? r.p - GAP : r.p + GAP;
}

const topOfIcebox = (ctx: Ctx, pid: number) => edgePosition(ctx, pid, "current_state = 'unscheduled'", 'top');
const bottomOfBacklog = (ctx: Ctx, pid: number) => edgePosition(ctx, pid, "current_state != 'unscheduled'", 'bottom');

// ---------------------------------------------------------------------------------------------
// Validation helpers

function estimatable(project: Project, type: StoryType) {
  return type === 'feature' || ((type === 'bug' || type === 'chore') && !!project.bugs_and_chores_are_estimatable);
}

function validateEstimate(project: Project, type: StoryType, estimate: number | null | undefined) {
  if (estimate == null) return;
  if (!estimatable(project, type)) {
    throw badRequest(
      `${type[0].toUpperCase() + type.slice(1)}s cannot be estimated in this project.`,
      type === 'release' ? undefined : 'Enable "bugs and chores may be given points" in project settings.',
    );
  }
  const scale = pointScale(project);
  if (!scale.includes(estimate)) throw badRequest(`Estimate ${estimate} is not on the project point scale (${scale.join(', ')}).`);
}

export function resolveLabelIds(ctx: Ctx, projectId: number, labelIds?: number[], labels?: StoryInput['labels']): number[] | undefined {
  if (labelIds === undefined && labels === undefined) return undefined;
  const out: number[] = [];
  for (const id of labelIds ?? []) {
    if (!ctx.db.get('SELECT 1 FROM labels WHERE id = ? AND project_id = ?', [id, projectId])) throw badRequest(`Label ${id} not found in project.`);
    out.push(id);
  }
  for (const l of labels ?? []) {
    if (typeof l === 'object' && l.id) {
      if (!ctx.db.get('SELECT 1 FROM labels WHERE id = ? AND project_id = ?', [l.id, projectId])) throw badRequest(`Label ${l.id} not found in project.`);
      out.push(l.id);
      continue;
    }
    const name = (typeof l === 'string' ? l : (l.name ?? '')).trim();
    if (!name) continue;
    out.push(findOrCreateLabel(ctx, projectId, name));
  }
  return [...new Set(out)];
}

export function findOrCreateLabel(ctx: Ctx, projectId: number, name: string): number {
  const existing = ctx.db.get<{ id: number }>('SELECT id FROM labels WHERE project_id = ? AND name = ? COLLATE NOCASE', [projectId, name]);
  if (existing) return existing.id;
  const ts = now();
  return ctx.db.insert('labels', { project_id: projectId, name: name.slice(0, 255), created_at: ts, updated_at: ts });
}

function checkMembers(ctx: Ctx, projectId: number, userIds: number[], what: string) {
  for (const id of userIds) if (!isMember(ctx, projectId, id)) throw badRequest(`${what} ${id} is not a member of this project.`);
}

function setOwners(ctx: Ctx, storyId: number, ownerIds: number[]) {
  ctx.db.run('DELETE FROM story_owners WHERE story_id = ?', [storyId]);
  ownerIds.forEach((uid, i) => ctx.db.run('INSERT OR IGNORE INTO story_owners (story_id, user_id, position) VALUES (?, ?, ?)', [storyId, uid, i]));
}

function addFollowers(ctx: Ctx, storyId: number, userIds: (number | null | undefined)[]) {
  for (const uid of userIds) if (uid) ctx.db.run('INSERT OR IGNORE INTO story_followers (story_id, user_id) VALUES (?, ?)', [storyId, uid]);
}

function setLabels(ctx: Ctx, storyId: number, labelIds: number[]) {
  ctx.db.run('DELETE FROM story_labels WHERE story_id = ?', [storyId]);
  for (const id of labelIds) ctx.db.run('INSERT OR IGNORE INTO story_labels (story_id, label_id) VALUES (?, ?)', [storyId, id]);
}

const ownerIdsOf = (ctx: Ctx, storyId: number) =>
  ctx.db.all<{ user_id: number }>('SELECT user_id FROM story_owners WHERE story_id = ? ORDER BY position, rowid', [storyId]).map((r) => r.user_id);
const labelIdsOf = (ctx: Ctx, storyId: number) =>
  ctx.db.all<{ label_id: number }>('SELECT label_id FROM story_labels WHERE story_id = ? ORDER BY label_id', [storyId]).map((r) => r.label_id);
const followerIdsOf = (ctx: Ctx, storyId: number) =>
  ctx.db.all<{ user_id: number }>('SELECT user_id FROM story_followers WHERE story_id = ?', [storyId]).map((r) => r.user_id);

function recordTransition(ctx: Ctx, story: { id: number; project_id: number }, state: string, user: User | null) {
  ctx.db.insert('story_transitions', {
    story_id: story.id,
    project_id: story.project_id,
    state,
    performed_by_id: user?.id ?? null,
    occurred_at: now(),
  });
}

function normDeadline(d: string | null | undefined): string | null | undefined {
  if (d === undefined || d === null) return d;
  const day = d.slice(0, 10);
  if (!isValidDate(day)) throw badRequest('deadline must be a date (YYYY-MM-DD) or ISO timestamp.');
  return day;
}

// ---------------------------------------------------------------------------------------------
// Create

export function createStory(ctx: Ctx, acc: Access, user: User | null, input: StoryInput, opts: { silent?: boolean } = {}): StoryRow {
  const { project } = acc;
  return ctx.tx(() => {
    const name = (input.name ?? '').trim();
    if (!name) throw badRequest('Story name is required.');
    const type: StoryType = input.story_type ?? 'feature';
    let state: StoryState = input.current_state ?? 'unscheduled';
    if (!ALLOWED_STATES[type].includes(state)) throw badRequest(`A ${type} cannot be in state "${state}".`);
    const estimate = input.estimate ?? null;
    validateEstimate(project, type, estimate);
    if (
      type === 'feature' &&
      estimate == null &&
      STARTED_STATES.has(state) &&
      pointScale(project).length > 0 &&
      state !== 'accepted'
    ) {
      throw badRequest('Unestimated feature stories cannot be started.', 'Give the story an estimate first.');
    }
    const requested_by_id = input.requested_by_id === undefined ? (user?.id ?? null) : input.requested_by_id;
    const ownerIds = input.owner_ids ?? [];
    if (requested_by_id) checkMembers(ctx, project.id, [requested_by_id], 'Requester');
    checkMembers(ctx, project.id, ownerIds, 'Owner');
    checkMembers(ctx, project.id, input.follower_ids ?? [], 'Follower');
    const labelIds = resolveLabelIds(ctx, project.id, input.label_ids, input.labels) ?? [];

    let position: number;
    if (input.before_id) position = positionBefore(ctx, project.id, input.before_id);
    else if (input.after_id) position = positionAfter(ctx, project.id, input.after_id);
    else position = state === 'unscheduled' ? topOfIcebox(ctx, project.id) : bottomOfBacklog(ctx, project.id);

    const ts = now();
    const id = ctx.db.insert('stories', {
      project_id: project.id,
      name: name.slice(0, 5000),
      description: input.description ?? '',
      story_type: type,
      current_state: state,
      estimate,
      position,
      requested_by_id,
      deadline: type === 'release' ? (normDeadline(input.deadline) ?? null) : null,
      accepted_at: state === 'accepted' ? (input.accepted_at ?? ts) : null,
      started_at: STARTED_STATES.has(state) ? (state === 'accepted' && input.accepted_at && input.accepted_at < ts ? input.accepted_at : ts) : null,
      planned_iteration_number: input.planned_iteration_number ?? null,
      external_id: input.external_id ?? null,
      created_at: ts,
      updated_at: ts,
    });
    const effectiveOwners = ownerIds.length === 0 && state === 'started' && user ? [user.id] : ownerIds;
    setOwners(ctx, id, effectiveOwners);
    setLabels(ctx, id, labelIds);
    addFollowers(ctx, id, [user?.id, requested_by_id, ...effectiveOwners, ...(input.follower_ids ?? [])]);
    (input.tasks ?? []).forEach((t, i) => {
      if (!t.description?.trim()) return;
      ctx.db.insert('tasks', { story_id: id, description: t.description.trim(), complete: t.complete ? 1 : 0, position: i + 1, created_at: ts, updated_at: ts });
    });
    if (state !== 'unscheduled' && state !== 'unstarted') recordTransition(ctx, { id, project_id: project.id }, state, user);
    const row = getStoryRow(ctx, id);
    if (!opts.silent) {
      recordActivity(ctx, {
        project_id: project.id,
        performer: user,
        kind: 'story_create_activity',
        highlight: 'added',
        message: `added "${row.name}"`,
        changes: [{ kind: 'story', change_type: 'create', id, name: row.name, story_type: type, new_values: snapshot(ctx, row) }],
        primary_resources: [{ kind: 'story', id, name: row.name, story_type: type, url: storyUrl(ctx, project.id, id) }],
        story_ids: [id],
      });
      notify(ctx, {
        user_ids: effectiveOwners,
        performer: user,
        project_id: project.id,
        story_id: id,
        notification_type: 'owner_added',
        message: `${user?.name ?? 'Someone'} made you an owner of "${row.name}"`,
      });
      notifyMentions(ctx, project.id, user, id, row.name, row.description, '');
    }
    return row;
  });
}

function snapshot(ctx: Ctx, s: StoryRow) {
  return {
    name: s.name,
    description: s.description,
    story_type: s.story_type,
    current_state: s.current_state,
    estimate: s.estimate,
    requested_by_id: s.requested_by_id,
    owner_ids: ownerIdsOf(ctx, s.id),
    label_ids: labelIdsOf(ctx, s.id),
    deadline: s.deadline,
    accepted_at: s.accepted_at,
    planned_iteration_number: s.planned_iteration_number,
    external_id: s.external_id,
  };
}

function notifyMentions(ctx: Ctx, projectId: number, user: User | null, storyId: number, name: string, text: string, previous: string) {
  const before = new Set(mentionedUserIds(ctx, projectId, previous));
  const mentioned = mentionedUserIds(ctx, projectId, text).filter((id) => !before.has(id));
  if (!mentioned.length) return;
  addFollowers(ctx, storyId, mentioned);
  notify(ctx, {
    user_ids: mentioned,
    performer: user,
    project_id: projectId,
    story_id: storyId,
    notification_type: 'mention',
    message: `${user?.name ?? 'Someone'} mentioned you in "${name}"`,
    context: text.slice(0, 500),
  });
}

// ---------------------------------------------------------------------------------------------
// Update

const STATE_VERBS: Record<string, string> = {
  started: 'started',
  finished: 'finished',
  delivered: 'delivered',
  accepted: 'accepted',
  rejected: 'rejected',
  unstarted: 'unstarted',
  unscheduled: 'moved into the icebox',
};

export function updateStory(ctx: Ctx, acc: Access, user: User | null, storyId: number, input: StoryInput): StoryRow {
  return ctx.tx(() => {
    let { project } = acc;
    const before = getStoryRow(ctx, storyId, project.id);

    if (input.project_id !== undefined && input.project_id !== project.id) {
      return moveToProject(ctx, acc, user, before, input);
    }

    const prev = snapshot(ctx, before);
    const changes: Record<string, unknown> = {};
    const type: StoryType = input.story_type ?? before.story_type;
    let state: StoryState = input.current_state ?? before.current_state;

    // Changing type may force a compatible state / clear estimate.
    if (input.story_type && input.story_type !== before.story_type) {
      if (!ALLOWED_STATES[type].includes(state)) {
        if (input.current_state) throw badRequest(`A ${type} cannot be in state "${state}".`);
        state = type === 'chore' ? 'started' : 'unstarted';
      }
    }
    if (!ALLOWED_STATES[type].includes(state)) throw badRequest(`A ${type} cannot be in state "${state}".`);

    let estimate = input.estimate !== undefined ? input.estimate : before.estimate;
    if (input.estimate === undefined && !estimatable(project, type)) estimate = null;
    validateEstimate(project, type, estimate);

    if (
      type === 'feature' &&
      estimate == null &&
      STARTED_STATES.has(state) &&
      state !== before.current_state &&
      state !== 'accepted' &&
      pointScale(project).length > 0
    ) {
      throw badRequest('Unestimated feature stories cannot be started.', 'Give the story an estimate first.');
    }

    const upd: Record<string, any> = {};
    if (input.name !== undefined) {
      const n = input.name.trim();
      if (!n) throw badRequest('Story name cannot be blank.');
      upd.name = n.slice(0, 5000);
    }
    if (input.description !== undefined) upd.description = input.description;
    if (type !== before.story_type) upd.story_type = type;
    if (estimate !== before.estimate) upd.estimate = estimate;
    if (input.requested_by_id !== undefined) {
      if (input.requested_by_id) checkMembers(ctx, project.id, [input.requested_by_id], 'Requester');
      upd.requested_by_id = input.requested_by_id;
    }
    if (input.deadline !== undefined) upd.deadline = type === 'release' ? normDeadline(input.deadline) : null;
    if (type !== 'release' && before.deadline) upd.deadline = null;
    if (input.planned_iteration_number !== undefined) upd.planned_iteration_number = input.planned_iteration_number;
    if (input.external_id !== undefined) upd.external_id = input.external_id;

    const ts = now();
    const stateChanged = state !== before.current_state;
    if (stateChanged) {
      upd.current_state = state;
      if (state === 'accepted') upd.accepted_at = input.accepted_at ?? ts;
      else upd.accepted_at = null;
      if (STARTED_STATES.has(state) && !before.started_at) upd.started_at = ts;
      if (state === 'unstarted' || state === 'unscheduled') upd.started_at = null;
    } else if (input.accepted_at !== undefined && state === 'accepted' && input.accepted_at) {
      upd.accepted_at = input.accepted_at;
    }

    // Repositioning
    let moved = false;
    if (input.before_id && input.before_id !== storyId) {
      upd.position = positionBefore(ctx, project.id, input.before_id, storyId);
      moved = true;
    } else if (input.after_id && input.after_id !== storyId) {
      upd.position = positionAfter(ctx, project.id, input.after_id, storyId);
      moved = true;
    } else if (stateChanged && state === 'unscheduled') {
      upd.position = topOfIcebox(ctx, project.id);
    } else if (stateChanged && before.current_state === 'unscheduled') {
      upd.position = bottomOfBacklog(ctx, project.id);
    }

    if (Object.keys(upd).length) {
      upd.updated_at = ts;
      ctx.db.update('stories', storyId, upd);
    }

    // Owners / followers / labels
    let ownerIds = input.owner_ids;
    if (ownerIds) checkMembers(ctx, project.id, ownerIds, 'Owner');
    if (stateChanged && state === 'started' && (ownerIds ?? prev.owner_ids).length === 0 && user) ownerIds = [user.id];
    if (ownerIds) setOwners(ctx, storyId, [...new Set(ownerIds)]);
    if (input.follower_ids) {
      checkMembers(ctx, project.id, input.follower_ids, 'Follower');
      ctx.db.run('DELETE FROM story_followers WHERE story_id = ?', [storyId]);
      addFollowers(ctx, storyId, input.follower_ids);
    }
    const labelIds = resolveLabelIds(ctx, project.id, input.label_ids, input.labels);
    if (labelIds) setLabels(ctx, storyId, labelIds);
    const newOwners = ownerIds ? ownerIds.filter((id) => !prev.owner_ids.includes(id)) : [];
    addFollowers(ctx, storyId, [...newOwners, upd.requested_by_id]);

    if (stateChanged) recordTransition(ctx, before, state, user);

    const after = getStoryRow(ctx, storyId);
    const next = snapshot(ctx, after);
    const orig: Record<string, unknown> = {};
    const nv: Record<string, unknown> = {};
    for (const k of Object.keys(next) as (keyof typeof next)[]) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) {
        orig[k] = prev[k];
        nv[k] = next[k];
      }
    }
    if (moved) {
      nv.before_id = input.before_id ?? null;
      nv.after_id = input.after_id ?? null;
    }
    Object.assign(changes, nv);
    if (!Object.keys(nv).length) return after;

    let highlight = 'edited';
    let message = `edited "${after.name}"`;
    if (stateChanged) {
      highlight = before.current_state === 'rejected' && state === 'started' ? 'restarted' : STATE_VERBS[state];
      if (before.current_state === 'unscheduled' && state === 'unstarted') highlight = 'moved into the backlog';
      message = `${highlight} "${after.name}"`;
    } else if (Object.keys(orig).length === 0 && moved) {
      highlight = 'moved';
      message = `moved "${after.name}"`;
    } else if (Object.keys(orig).length === 1 && 'estimate' in orig) {
      highlight = 'estimated';
      message = after.estimate == null ? `unestimated "${after.name}"` : `estimated "${after.name}" as ${after.estimate} point${after.estimate === 1 ? '' : 's'}`;
    }
    const change: Change = { kind: 'story', change_type: 'update', id: storyId, name: after.name, story_type: after.story_type, original_values: orig, new_values: nv };
    recordActivity(ctx, {
      project_id: project.id,
      performer: user,
      kind: 'story_update_activity',
      highlight,
      message,
      changes: [change],
      primary_resources: [{ kind: 'story', id: storyId, name: after.name, story_type: after.story_type, url: storyUrl(ctx, project.id, storyId) }],
      story_ids: [storyId],
    });

    // Notifications
    const actor = user?.name ?? 'Someone';
    notify(ctx, {
      user_ids: newOwners,
      performer: user,
      project_id: project.id,
      story_id: storyId,
      notification_type: 'owner_added',
      message: `${actor} made you an owner of "${after.name}"`,
    });
    if (stateChanged && state === 'delivered' && after.requested_by_id) {
      notify(ctx, {
        user_ids: [after.requested_by_id],
        performer: user,
        project_id: project.id,
        story_id: storyId,
        notification_type: 'story_delivered',
        message: `${actor} delivered "${after.name}" — please accept or reject it`,
      });
    }
    if (stateChanged && (state === 'accepted' || state === 'rejected')) {
      notify(ctx, {
        user_ids: next.owner_ids,
        performer: user,
        project_id: project.id,
        story_id: storyId,
        notification_type: `story_${state}`,
        message: `${actor} ${state} "${after.name}"`,
      });
    }
    if (input.description !== undefined) notifyMentions(ctx, project.id, user, storyId, after.name, after.description, before.description);
    return after;
  });
}

function moveToProject(ctx: Ctx, acc: Access, user: User | null, story: StoryRow, input: StoryInput): StoryRow {
  const target = accessFor(ctx, input.project_id!, user, 'member').project;
  const source = acc.project;
  // Re-create labels by name in the target project.
  const labelNames = ctx.db
    .all<{ name: string }>('SELECT l.name FROM story_labels sl JOIN labels l ON l.id = sl.label_id WHERE sl.story_id = ?', [story.id])
    .map((l) => l.name);
  const newLabelIds = labelNames.map((n) => findOrCreateLabel(ctx, target.id, n));
  setLabels(ctx, story.id, newLabelIds);
  // Drop people who aren't members of the target project, and reviews (review types are per-project).
  const keep = (uid: number) => isMember(ctx, target.id, uid);
  setOwners(ctx, story.id, ownerIdsOf(ctx, story.id).filter(keep));
  for (const f of followerIdsOf(ctx, story.id)) if (!keep(f)) ctx.db.run('DELETE FROM story_followers WHERE story_id = ? AND user_id = ?', [story.id, f]);
  ctx.db.run('DELETE FROM reviews WHERE story_id = ?', [story.id]);
  let estimate = story.estimate;
  if (estimate != null && (!pointScale(target).includes(estimate) || !estimatable(target, story.story_type))) estimate = null;
  let state = story.current_state;
  if (story.story_type === 'feature' && estimate == null && STARTED_STATES.has(state) && state !== 'accepted') state = 'unstarted';
  const position = state === 'unscheduled' ? topOfIcebox(ctx, target.id) : bottomOfBacklog(ctx, target.id);
  ctx.db.update('stories', story.id, {
    project_id: target.id,
    position,
    estimate,
    current_state: state,
    requested_by_id: story.requested_by_id && keep(story.requested_by_id) ? story.requested_by_id : (user?.id ?? null),
    updated_at: now(),
  });
  ctx.db.run('UPDATE comments SET project_id = ? WHERE story_id = ?', [target.id, story.id]);
  ctx.db.run('UPDATE attachments SET project_id = ? WHERE comment_id IN (SELECT id FROM comments WHERE story_id = ?)', [target.id, story.id]);
  ctx.db.run('UPDATE story_transitions SET project_id = ? WHERE story_id = ?', [target.id, story.id]);
  const res = { kind: 'story', id: story.id, name: story.name, story_type: story.story_type, url: storyUrl(ctx, target.id, story.id) };
  recordActivity(ctx, {
    project_id: source.id,
    performer: user,
    kind: 'story_move_from_project_activity',
    highlight: 'moved',
    message: `moved "${story.name}" to project "${target.name}"`,
    changes: [{ kind: 'story', change_type: 'delete', id: story.id, name: story.name, story_type: story.story_type }],
    primary_resources: [res],
    story_ids: [story.id],
  });
  recordActivity(ctx, {
    project_id: target.id,
    performer: user,
    kind: 'story_move_into_project_activity',
    highlight: 'moved',
    message: `moved "${story.name}" from project "${source.name}"`,
    changes: [{ kind: 'story', change_type: 'create', id: story.id, name: story.name, story_type: story.story_type }],
    primary_resources: [res],
    story_ids: [story.id],
  });
  return getStoryRow(ctx, story.id);
}

// ---------------------------------------------------------------------------------------------
// Delete

export function deleteStory(ctx: Ctx, acc: Access, user: User | null, storyId: number) {
  ctx.tx(() => {
    const s = getStoryRow(ctx, storyId, acc.project.id);
    // Remove stored files for this story's comments.
    ctx.db.run('DELETE FROM stories WHERE id = ?', [storyId]);
    recordActivity(ctx, {
      project_id: acc.project.id,
      performer: user,
      kind: 'story_delete_activity',
      highlight: 'deleted',
      message: `deleted "${s.name}"`,
      changes: [{ kind: 'story', change_type: 'delete', id: s.id, name: s.name, story_type: s.story_type }],
      primary_resources: [{ kind: 'story', id: s.id, name: s.name, story_type: s.story_type }],
      story_ids: [s.id],
    });
  });
}

/** Load stories for a project in priority order, optionally filtered by SQL. */
export function storyRows(ctx: Ctx, projectId: number, where = '1=1', params: any[] = []): StoryRow[] {
  return ctx.db.all<StoryRow>(`SELECT * FROM stories WHERE project_id = ? AND (${where}) ORDER BY position, id`, [projectId, ...params]);
}

export function storyRowsByIds(ctx: Ctx, idList: number[]): StoryRow[] {
  if (!idList.length) return [];
  const rows = ctx.db.all<StoryRow>('SELECT * FROM stories WHERE id IN (SELECT value FROM json_each(?))', [ids(idList)]);
  const order = new Map(idList.map((id, i) => [id, i]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}
