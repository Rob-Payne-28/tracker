/**
 * Iteration planning engine.
 *
 * Given a project's settings and stories, computes:
 *  - the iteration calendar (start/finish dates, honouring per-iteration length and team strength overrides)
 *  - the project's velocity (average normalised points accepted over the last N completed iterations)
 *  - "done" iterations (accepted stories bucketed by acceptance date)
 *  - the current iteration and projected backlog iterations, filled by velocity (automatic planning)
 *    or by each story's planned_iteration_number (manual planning)
 *  - the icebox
 *
 * Everything here is pure and side-effect free so it can be unit tested and reused for analytics.
 */
import { addDays, alignToWeekday, localDate, type Weekday } from './dates.js';

export interface PlanProject {
  iteration_length: number;
  week_start_day: string;
  start_date: string;
  time_zone: string;
  initial_velocity: number;
  velocity_averaged_over: number;
  bugs_and_chores_are_estimatable: boolean | number;
  automatic_planning: boolean | number;
}

export interface PlanStory {
  id: number;
  story_type: string;
  current_state: string;
  estimate: number | null;
  position: number;
  accepted_at: string | null;
  deadline?: string | null;
  planned_iteration_number?: number | null;
}

export interface IterationOverride {
  number: number;
  length: number | null;
  team_strength: number;
}

export type IterationScope = 'done' | 'current' | 'backlog';

export interface PlannedIteration {
  number: number;
  scope: IterationScope;
  start: string;
  /** Exclusive finish date (the start of the following iteration). */
  finish: string;
  length: number;
  team_strength: number;
  story_ids: number[];
  points: number;
  accepted_points: number;
  /** Points the iteration can hold given velocity, length and team strength (current/backlog only). */
  capacity: number | null;
}

export interface ReleaseProjection {
  story_id: number;
  iteration_number: number | null;
  projected_completion: string | null;
  behind_schedule: boolean;
}

export interface Plan {
  velocity: number;
  current_iteration_number: number;
  iterations: PlannedIteration[];
  icebox_ids: number[];
  /** Manual planning only: unstarted stories with no planned iteration. */
  unplanned_ids: number[];
  releases: ReleaseProjection[];
}

const IN_PROGRESS = new Set(['started', 'finished', 'delivered', 'rejected']);

export function storyPoints(s: Pick<PlanStory, 'story_type' | 'estimate'>, project: Pick<PlanProject, 'bugs_and_chores_are_estimatable'>): number {
  if (s.estimate == null || s.estimate <= 0) return 0;
  if (s.story_type === 'feature') return s.estimate;
  if ((s.story_type === 'bug' || s.story_type === 'chore') && project.bugs_and_chores_are_estimatable) return s.estimate;
  return 0;
}

/** Lazily computes iteration date bounds, taking per-iteration length overrides into account. */
export class IterationCalendar {
  private starts: string[] = [];
  private readonly overrides: Map<number, IterationOverride>;
  readonly origin: string;

  constructor(
    private project: PlanProject,
    overrides: IterationOverride[],
  ) {
    this.overrides = new Map(overrides.map((o) => [o.number, o]));
    this.origin = alignToWeekday(project.start_date, project.week_start_day as Weekday);
    this.starts = [this.origin];
  }

  length(n: number): number {
    const o = this.overrides.get(n);
    return Math.max(1, o?.length ?? this.project.iteration_length);
  }

  strength(n: number): number {
    const o = this.overrides.get(n);
    return o ? Math.max(0, o.team_strength) : 1;
  }

  start(n: number): string {
    while (this.starts.length < n) {
      const k = this.starts.length; // iteration number of last known start
      this.starts.push(addDays(this.starts[k - 1], this.length(k) * 7));
    }
    return this.starts[n - 1];
  }

  finish(n: number): string {
    return this.start(n + 1);
  }

  /** Iteration number containing a date (dates before the project start map to iteration 1). */
  numberFor(date: string): number {
    if (date < this.origin) return 1;
    let n = 1;
    while (this.finish(n) <= date) n++;
    return n;
  }
}

export interface PlanOptions {
  today?: string;
  /** "What if" velocity override. */
  velocity?: number;
  /** Number of done iterations to include (most recent). Default: all. */
  doneLimit?: number;
}

export function computePlan(
  project: PlanProject,
  stories: PlanStory[],
  overrides: IterationOverride[],
  opts: PlanOptions = {},
): Plan {
  const tz = project.time_zone || 'UTC';
  const today = opts.today ?? localDate(new Date(), tz);
  const cal = new IterationCalendar(project, overrides);
  const current = cal.numberFor(today);
  const pts = (s: PlanStory) => storyPoints(s, project);

  // ---- Done iterations: bucket accepted stories by local acceptance date.
  const accepted = stories
    .filter((s) => s.current_state === 'accepted')
    .sort((a, b) => (a.accepted_at ?? '').localeCompare(b.accepted_at ?? '') || a.position - b.position);
  const doneBuckets = new Map<number, PlanStory[]>();
  const currentAccepted: PlanStory[] = [];
  for (const s of accepted) {
    const n = s.accepted_at ? Math.min(cal.numberFor(localDate(s.accepted_at, tz)), current) : current;
    if (n >= current) currentAccepted.push(s);
    else {
      if (!doneBuckets.has(n)) doneBuckets.set(n, []);
      doneBuckets.get(n)!.push(s);
    }
  }

  const iterations: PlannedIteration[] = [];
  const normalised: number[] = [];
  for (let n = 1; n < current; n++) {
    const list = doneBuckets.get(n) ?? [];
    const points = list.reduce((sum, s) => sum + pts(s), 0);
    const strength = cal.strength(n);
    const length = cal.length(n);
    if (strength > 0) normalised.push((points / strength) * (project.iteration_length / length));
    iterations.push({
      number: n,
      scope: 'done',
      start: cal.start(n),
      finish: cal.finish(n),
      length,
      team_strength: strength,
      story_ids: list.map((s) => s.id),
      points,
      accepted_points: points,
      capacity: null,
    });
  }

  // ---- Velocity
  let velocity: number;
  if (opts.velocity != null && opts.velocity > 0) velocity = opts.velocity;
  else {
    const recent = normalised.slice(-Math.max(1, project.velocity_averaged_over));
    velocity = recent.length
      ? Math.max(1, Math.floor(recent.reduce((a, b) => a + b, 0) / recent.length))
      : Math.max(1, project.initial_velocity);
  }
  const capacityOf = (n: number) => (velocity * cal.strength(n) * cal.length(n)) / project.iteration_length;

  // ---- Current + backlog
  const byPos = (a: PlanStory, b: PlanStory) => a.position - b.position;
  const inProgress = stories.filter((s) => IN_PROGRESS.has(s.current_state)).sort(byPos);
  const unstarted = stories.filter((s) => s.current_state === 'unstarted' || s.current_state === 'planned').sort(byPos);
  const icebox = stories.filter((s) => s.current_state === 'unscheduled').sort(byPos);

  const mk = (n: number, scope: IterationScope): PlannedIteration => ({
    number: n,
    scope,
    start: cal.start(n),
    finish: cal.finish(n),
    length: cal.length(n),
    team_strength: cal.strength(n),
    story_ids: [],
    points: 0,
    accepted_points: 0,
    capacity: Math.round(capacityOf(n) * 100) / 100,
  });
  const add = (it: PlannedIteration, s: PlanStory) => {
    it.story_ids.push(s.id);
    const p = pts(s);
    it.points += p;
    if (s.current_state === 'accepted') it.accepted_points += p;
  };

  const cur = mk(current, 'current');
  for (const s of currentAccepted) add(cur, s);
  for (const s of inProgress) add(cur, s);

  const future: PlannedIteration[] = [];
  const unplanned: number[] = [];
  const iterationOf = new Map<number, PlannedIteration>();

  if (project.automatic_planning) {
    // Walk the prioritised backlog in order. A story goes into the iteration being filled if it fits
    // in the remaining capacity; otherwise that iteration closes (no back-filling with smaller stories,
    // which would break priority order). An empty iteration accepts any story, so oversized stories get
    // an iteration of their own. Zero-capacity iterations (team strength 0%) are skipped.
    let it = cur;
    let guard = 0;
    for (const s of unstarted) {
      const p = pts(s);
      while (guard < 5000) {
        const cap = capacityOf(it.number);
        if (cap > 0 && (it.points + p <= cap + 1e-9 || it.story_ids.length === 0)) break;
        it = mk(it.number + 1, 'backlog');
        future.push(it);
        guard++;
      }
      add(it, s);
      iterationOf.set(s.id, it);
    }
  } else {
    const planned = new Map<number, PlannedIteration>();
    for (const s of unstarted) {
      const n = s.planned_iteration_number;
      if (n == null) {
        unplanned.push(s.id);
        continue;
      }
      const target = n <= current ? cur : (planned.get(n) ?? mk(n, 'backlog'));
      if (target !== cur) planned.set(n, target);
      add(target, s);
      iterationOf.set(s.id, target);
    }
    future.push(...[...planned.values()].sort((a, b) => a.number - b.number));
  }
  for (const s of [...currentAccepted, ...inProgress]) iterationOf.set(s.id, cur);

  const doneFiltered =
    opts.doneLimit != null ? iterations.slice(Math.max(0, iterations.length - opts.doneLimit)) : iterations;

  const releases: ReleaseProjection[] = stories
    .filter((s) => s.story_type === 'release' && s.current_state !== 'accepted')
    .map((s) => {
      const it = iterationOf.get(s.id);
      const projected = it ? addDays(it.finish, -1) : null;
      return {
        story_id: s.id,
        iteration_number: it?.number ?? null,
        projected_completion: projected,
        behind_schedule: !!(s.deadline && projected && projected > s.deadline.slice(0, 10)),
      };
    });

  return {
    velocity,
    current_iteration_number: current,
    iterations: [...doneFiltered, cur, ...future.filter((f) => f.story_ids.length > 0)],
    icebox_ids: icebox.map((s) => s.id),
    unplanned_ids: unplanned,
    releases,
  };
}
