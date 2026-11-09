import type { Ctx } from './context.js';
import type { User } from './people.js';
import { personJson } from './people.js';
import { forbidden, notFound } from '../lib/errors.js';
import { computePlan, type IterationOverride, type PlanStory } from '../lib/iterations.js';

export type Role = 'owner' | 'member' | 'viewer';
const RANK: Record<Role, number> = { viewer: 1, member: 2, owner: 3 };

export interface Project {
  id: number;
  name: string;
  description: string;
  iteration_length: number;
  week_start_day: string;
  point_scale: string;
  initial_velocity: number;
  velocity_averaged_over: number;
  bugs_and_chores_are_estimatable: number;
  automatic_planning: number;
  enable_tasks: number;
  public: number;
  archived: number;
  start_date: string;
  time_zone: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Access {
  project: Project;
  role: Role | null;
}

export function getProject(ctx: Ctx, id: number): Project {
  const p = ctx.db.get<Project>('SELECT * FROM projects WHERE id = ?', [id]);
  if (!p) throw notFound('Project');
  return p;
}

export function roleFor(ctx: Ctx, projectId: number, userId: number | undefined): Role | null {
  if (!userId) return null;
  const m = ctx.db.get<{ role: Role }>('SELECT role FROM memberships WHERE project_id = ? AND user_id = ?', [projectId, userId]);
  return m?.role ?? null;
}

/**
 * Load a project and verify the user's access. Viewers can read; members can edit stories;
 * owners manage settings and memberships. Public projects are readable by anyone. Instance
 * admins have owner access everywhere.
 */
export function access(ctx: Ctx, projectId: number, user: User | null, need: Role): Access {
  const project = getProject(ctx, projectId);
  let role = roleFor(ctx, projectId, user?.id);
  if (!role && user?.is_admin) role = 'owner';
  if (!role) {
    if (need === 'viewer' && project.public) return { project, role: null };
    throw notFound('Project'); // don't leak existence of private projects
  }
  if (RANK[role] < RANK[need]) {
    throw forbidden(need === 'owner' ? 'Only project owners can do this.' : 'Viewers cannot modify this project.');
  }
  if (need !== 'viewer' && project.archived && need !== 'owner') throw forbidden('This project is archived.');
  return { project, role };
}

export function pointScale(p: Pick<Project, 'point_scale'>): number[] {
  return p.point_scale
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

export function overridesFor(ctx: Ctx, projectId: number): IterationOverride[] {
  return ctx.db.all<IterationOverride>('SELECT number, length, team_strength FROM iteration_overrides WHERE project_id = ?', [
    projectId,
  ]);
}

export function planFor(ctx: Ctx, project: Project, opts: { velocity?: number; today?: string } = {}) {
  const stories = ctx.db.all<PlanStory>(
    `SELECT id, story_type, current_state, estimate, position, accepted_at, deadline, planned_iteration_number
       FROM stories WHERE project_id = ?`,
    [project.id],
  );
  return computePlan(project, stories, overridesFor(ctx, project.id), opts);
}

export function projectJson(ctx: Ctx, p: Project, role: Role | null, plan?: ReturnType<typeof planFor>) {
  const pl = plan ?? planFor(ctx, p);
  return {
    kind: 'project',
    id: p.id,
    name: p.name,
    description: p.description,
    iteration_length: p.iteration_length,
    week_start_day: p.week_start_day,
    point_scale: p.point_scale,
    initial_velocity: p.initial_velocity,
    velocity_averaged_over: p.velocity_averaged_over,
    bugs_and_chores_are_estimatable: !!p.bugs_and_chores_are_estimatable,
    automatic_planning: !!p.automatic_planning,
    enable_tasks: !!p.enable_tasks,
    public: !!p.public,
    archived: !!p.archived,
    start_date: p.start_date,
    time_zone: p.time_zone,
    version: p.version,
    current_iteration_number: pl.current_iteration_number,
    current_velocity: pl.velocity,
    role,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

/** Serialize a membership row joined with users (name, email, initials, username). */
export function membershipJson(m: any) {
  return {
    kind: 'project_membership',
    id: m.id as number,
    project_id: m.project_id as number,
    role: m.role as Role,
    project_color: m.project_color as string,
    last_viewed_at: (m.last_viewed_at as string) ?? null,
    created_at: m.created_at as string,
    updated_at: m.updated_at as string,
    person: personJson({ id: m.user_id, name: m.name, email: m.email, initials: m.initials, username: m.username }),
  };
}

export function membershipsFor(ctx: Ctx, projectId: number) {
  return ctx.db
    .all(
      `SELECT m.*, u.name, u.email, u.initials, u.username FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = ? ORDER BY u.name COLLATE NOCASE`,
      [projectId],
    )
    .map(membershipJson);
}

export function isMember(ctx: Ctx, projectId: number, userId: number) {
  return !!ctx.db.get('SELECT 1 FROM memberships WHERE project_id = ? AND user_id = ?', [projectId, userId]);
}
