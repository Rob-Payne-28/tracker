/**
 * Property-based tests for the iteration planning engine. Random projects and backlogs are generated
 * from a seeded PRNG (so failures are reproducible: the failing seed is printed) and the plan is checked
 * against invariants that must hold for every input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, storyPoints, type IterationOverride, type PlanProject, type PlanStory } from '../src/lib/iterations.js';
import { addDays } from '../src/lib/dates.js';

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ['feature', 'feature', 'feature', 'bug', 'chore', 'release'] as const;
const STATES = ['unscheduled', 'unstarted', 'unstarted', 'unstarted', 'started', 'finished', 'delivered', 'rejected', 'accepted', 'accepted'] as const;
const SCALE = [0, 1, 2, 3, 5, 8];
const TODAY = '2026-06-10';

function scenario(seed: number) {
  const r = prng(seed);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const project: PlanProject = {
    iteration_length: 1 + Math.floor(r() * 3),
    week_start_day: pick(['Monday', 'Sunday', 'Wednesday']),
    start_date: addDays(TODAY, -Math.floor(r() * 120)),
    time_zone: pick(['UTC', 'America/Los_Angeles', 'Asia/Tokyo']),
    initial_velocity: 1 + Math.floor(r() * 20),
    velocity_averaged_over: 1 + Math.floor(r() * 5),
    bugs_and_chores_are_estimatable: r() < 0.3,
    automatic_planning: true,
  };
  const n = Math.floor(r() * 60);
  const stories: PlanStory[] = [];
  for (let i = 0; i < n; i++) {
    const story_type = pick(TYPES);
    let current_state: string = pick(STATES);
    if (story_type === 'release' && !['unscheduled', 'unstarted', 'accepted'].includes(current_state)) current_state = 'unstarted';
    const estimable = story_type === 'feature' || (story_type !== 'release' && project.bugs_and_chores_are_estimatable);
    stories.push({
      id: i + 1,
      story_type,
      current_state,
      estimate: estimable && r() < 0.85 ? pick(SCALE) : null,
      position: Math.floor(r() * 100000) + r(),
      accepted_at: current_state === 'accepted' ? new Date(Date.parse(project.start_date) + r() * 140 * 86400000).toISOString() : null,
      deadline: story_type === 'release' && r() < 0.5 ? addDays(TODAY, Math.floor(r() * 60) - 10) : null,
    });
  }
  const overrides: IterationOverride[] = [];
  for (let k = 0; k < Math.floor(r() * 4); k++) {
    overrides.push({ number: 1 + Math.floor(r() * 40), length: r() < 0.3 ? 1 + Math.floor(r() * 3) : null, team_strength: pick([0, 0.5, 1, 1.5]) });
  }
  const uniq = new Map(overrides.map((o) => [o.number, o]));
  return { project, stories, overrides: [...uniq.values()] };
}

const IN_PROGRESS = new Set(['started', 'finished', 'delivered', 'rejected']);

function checkInvariants(seed: number) {
  const { project, stories, overrides } = scenario(seed);
  const plan = computePlan(project, stories, overrides, { today: TODAY });
  const byId = new Map(stories.map((s) => [s.id, s]));
  const pts = (id: number) => storyPoints(byId.get(id)!, project);
  const ctx = `seed=${seed}`;

  assert.ok(plan.velocity >= 1, `${ctx}: velocity must be >= 1`);

  // Every story appears exactly once: in an iteration or in the icebox.
  const placed = [...plan.iterations.flatMap((i) => i.story_ids), ...plan.icebox_ids, ...plan.unplanned_ids];
  assert.equal(new Set(placed).size, placed.length, `${ctx}: a story was placed twice`);
  assert.deepEqual([...placed].sort((a, b) => a - b), stories.map((s) => s.id).sort((a, b) => a - b), `${ctx}: every story placed exactly once`);

  // Icebox: all unscheduled stories, in priority order.
  const ice = stories.filter((s) => s.current_state === 'unscheduled').sort((a, b) => a.position - b.position).map((s) => s.id);
  assert.deepEqual(plan.icebox_ids, ice, `${ctx}: icebox order`);

  // Iterations are consecutive in number, dates are contiguous and done < current < backlog.
  const cur = plan.iterations.find((i) => i.scope === 'current')!;
  assert.ok(cur, `${ctx}: there is a current iteration`);
  assert.ok(cur.start <= TODAY && TODAY < cur.finish, `${ctx}: current iteration contains today`);
  for (let k = 1; k < plan.iterations.length; k++) {
    const a = plan.iterations[k - 1];
    const b = plan.iterations[k];
    assert.ok(a.number < b.number, `${ctx}: iteration numbers increase`);
    if (b.number === a.number + 1) assert.equal(a.finish, b.start, `${ctx}: iteration ${a.number} and ${b.number} are contiguous`);
  }

  // In-progress stories always sit in the current iteration.
  for (const s of stories) if (IN_PROGRESS.has(s.current_state)) assert.ok(cur.story_ids.includes(s.id), `${ctx}: in-progress ${s.id} in current`);
  // Accepted stories are in a done iteration or the current one, never the backlog.
  for (const s of stories) {
    if (s.current_state !== 'accepted') continue;
    const it = plan.iterations.find((i) => i.story_ids.includes(s.id))!;
    assert.ok(it.scope !== 'backlog', `${ctx}: accepted story ${s.id} not in backlog`);
  }

  // Priority order of unstarted stories is preserved across current + backlog.
  const unstartedInPlan = plan.iterations.filter((i) => i.scope !== 'done').flatMap((i) => i.story_ids).filter((id) => byId.get(id)!.current_state === 'unstarted');
  const expected = stories.filter((s) => s.current_state === 'unstarted').sort((a, b) => a.position - b.position).map((s) => s.id);
  assert.deepEqual(unstartedInPlan, expected, `${ctx}: backlog order preserved`);

  // Capacity: backlog iterations never exceed capacity unless they hold a single (oversized) story,
  // and zero-capacity iterations hold nothing.
  const future = plan.iterations.filter((i) => i.scope === 'backlog');
  for (const it of future) {
    assert.ok(it.capacity! > 0, `${ctx}: zero-capacity iteration ${it.number} must be skipped`);
    assert.ok(it.points <= it.capacity! + 1e-6 || it.story_ids.length === 1, `${ctx}: iteration ${it.number} over capacity`);
    assert.equal(it.points, it.story_ids.reduce((n, id) => n + pts(id), 0), `${ctx}: points add up`);
  }

  // No back-filling: the first story of each backlog iteration did not fit in the previous one.
  const live = [cur, ...future];
  for (let k = 1; k < live.length; k++) {
    const prev = live[k - 1];
    const next = live[k];
    // (A zero-capacity iteration — 0% team strength — legitimately takes nothing, not even 0-point stories.)
    if (next.number !== prev.number + 1 || !prev.story_ids.length || !(prev.capacity! > 0)) continue;
    const first = next.story_ids[0];
    assert.ok(prev.points + pts(first) > prev.capacity! + 1e-6, `${ctx}: story ${first} would have fit in iteration ${prev.number}`);
  }

  // Done iteration points equal the sum of accepted story points.
  for (const it of plan.iterations.filter((i) => i.scope === 'done')) {
    assert.equal(it.points, it.story_ids.reduce((n, id) => n + pts(id), 0), `${ctx}: done points`);
  }
}

test('planning invariants hold for 500 random projects', () => {
  for (let seed = 1; seed <= 500; seed++) checkInvariants(seed);
});

test('planning is deterministic', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const { project, stories, overrides } = scenario(seed);
    const a = computePlan(project, stories, overrides, { today: TODAY });
    const b = computePlan(project, [...stories].reverse(), overrides, { today: TODAY });
    assert.deepEqual(a, b, `seed=${seed}: input order must not matter`);
  }
});
