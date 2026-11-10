import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, IterationCalendar, type PlanProject, type PlanStory } from '../src/lib/iterations.js';
import { parseQuery } from '../src/services/search.js';
import { parseCommitMessage } from '../src/routes/integrations.js';
import { parseCsv, toCsv } from '../src/lib/csv.js';

const project: PlanProject = {
  iteration_length: 1,
  week_start_day: 'Monday',
  start_date: '2026-01-05', // a Monday
  time_zone: 'UTC',
  initial_velocity: 5,
  velocity_averaged_over: 3,
  bugs_and_chores_are_estimatable: false,
  automatic_planning: true,
};

let nextId = 1;
const story = (o: Partial<PlanStory>): PlanStory => ({
  id: nextId++,
  story_type: 'feature',
  current_state: 'unstarted',
  estimate: 1,
  position: nextId * 10,
  accepted_at: null,
  ...o,
});

test('calendar aligns start to week_start_day and honours length overrides', () => {
  const cal = new IterationCalendar({ ...project, start_date: '2026-01-07' }, [{ number: 2, length: 2, team_strength: 1 }]);
  assert.equal(cal.start(1), '2026-01-05');
  assert.equal(cal.start(2), '2026-01-12');
  assert.equal(cal.start(3), '2026-01-26'); // iteration 2 lasts two weeks
  assert.equal(cal.numberFor('2026-01-25'), 2);
  assert.equal(cal.numberFor('2026-01-26'), 3);
  assert.equal(cal.numberFor('2025-12-01'), 1);
});

test('uses initial velocity when no iterations are done and fills backlog in order without back-filling', () => {
  const stories = [story({ estimate: 3 }), story({ estimate: 3 }), story({ estimate: 1 }), story({ estimate: 2 })];
  const plan = computePlan(project, stories, [], { today: '2026-01-06' });
  assert.equal(plan.velocity, 5);
  assert.equal(plan.current_iteration_number, 1);
  const [cur, next] = plan.iterations;
  assert.deepEqual(cur.story_ids, [stories[0].id]); // 3 fits, next 3 does not (6 > 5)
  // The 1-pointer must not jump ahead of the second 3-pointer.
  assert.deepEqual(next.story_ids, [stories[1].id, stories[2].id]);
  assert.equal(plan.iterations[2].story_ids[0], stories[3].id);
});

test('velocity averages normalised points over recent done iterations', () => {
  const s = [
    story({ current_state: 'accepted', estimate: 8, accepted_at: '2026-01-06T10:00:00Z' }), // it 1
    story({ current_state: 'accepted', estimate: 2, accepted_at: '2026-01-13T10:00:00Z' }), // it 2 (50% strength → 4)
    story({ current_state: 'accepted', estimate: 3, accepted_at: '2026-01-20T10:00:00Z' }), // it 3
    story({ current_state: 'accepted', estimate: 5, accepted_at: '2026-01-27T10:00:00Z' }), // it 4
  ];
  const plan = computePlan(project, s, [{ number: 2, length: null, team_strength: 0.5 }], { today: '2026-02-03' });
  assert.equal(plan.current_iteration_number, 5);
  // last three: it2 = 4, it3 = 3, it4 = 5 → avg 4
  assert.equal(plan.velocity, 4);
  const done = plan.iterations.filter((i) => i.scope === 'done');
  assert.equal(done.length, 4);
  assert.deepEqual(done.map((d) => d.points), [8, 2, 3, 5]);
});

test('in-progress stories always occupy the current iteration; oversized stories get their own iteration', () => {
  const s = [
    story({ current_state: 'started', estimate: 8 }),
    story({ estimate: 1 }),
    story({ estimate: 8 }),
    story({ estimate: 1 }),
  ];
  const plan = computePlan(project, s, [], { today: '2026-01-06' });
  assert.deepEqual(plan.iterations[0].story_ids, [s[0].id]); // 8 > 5 already
  assert.deepEqual(plan.iterations[1].story_ids, [s[1].id]);
  assert.deepEqual(plan.iterations[2].story_ids, [s[2].id]); // 8 alone
  assert.deepEqual(plan.iterations[3].story_ids, [s[3].id]);
});

test('zero-strength iterations are skipped and bugs/chores carry no points by default', () => {
  const s = [story({ estimate: 5 }), story({ story_type: 'bug', estimate: null }), story({ estimate: 5 })];
  const plan = computePlan(project, s, [{ number: 2, length: null, team_strength: 0 }], { today: '2026-01-06' });
  assert.deepEqual(plan.iterations[0].story_ids, [s[0].id, s[1].id]);
  assert.equal(plan.iterations[1].number, 3);
  assert.deepEqual(plan.iterations[1].story_ids, [s[2].id]);
});

test('manual planning places stories by planned_iteration_number', () => {
  const s = [story({ planned_iteration_number: 3 }), story({ planned_iteration_number: null }), story({ planned_iteration_number: 1 })];
  const plan = computePlan({ ...project, automatic_planning: false }, s, [], { today: '2026-01-06' });
  assert.deepEqual(plan.iterations[0].story_ids, [s[2].id]);
  assert.equal(plan.iterations[1].number, 3);
  assert.deepEqual(plan.unplanned_ids, [s[1].id]);
});

test('release projections flag missed deadlines', () => {
  const s = [story({ estimate: 5 }), story({ estimate: 5 }), story({ story_type: 'release', estimate: null, deadline: '2026-01-10' })];
  const plan = computePlan(project, s, [], { today: '2026-01-06' });
  const r = plan.releases[0];
  assert.equal(r.iteration_number, 2);
  assert.equal(r.projected_completion, '2026-01-18');
  assert.equal(r.behind_schedule, true);
});

test('search query parser', () => {
  const q = parseQuery('login -label:"won\'t fix" owner:me,jd "exact phrase" -flaky includedone:true');
  assert.deepEqual(q.terms, [
    { text: 'login', negate: false },
    { text: 'exact phrase', negate: false },
    { text: 'flaky', negate: true },
  ]);
  assert.deepEqual(q.filters, [
    { key: 'label', values: ["won't fix"], negate: true },
    { key: 'owner', values: ['me', 'jd'], negate: false },
  ]);
  assert.equal(q.includeDone, true);
  assert.equal(parseQuery('state:accepted').includeDone, true);
});

test('commit message parser', () => {
  assert.deepEqual(parseCommitMessage('Fix login [Finishes #12] and [#13 #14] [Delivers #14]'), [
    { story_id: 12, action: 'finish' },
    { story_id: 13, action: null },
    { story_id: 14, action: 'deliver' },
  ]);
  assert.deepEqual(parseCommitMessage('[fixed #7]'), [{ story_id: 7, action: 'finish' }]);
  assert.deepEqual(parseCommitMessage('no refs #9'), []);
});

test('csv round trip', () => {
  const rows = [
    ['a', 'b,c', 'say "hi"'],
    ['line\nbreak', '', '=1+1'],
  ];
  const parsed = parseCsv(toCsv(rows));
  assert.deepEqual(parsed[0], rows[0]);
  assert.equal(parsed[1][0], 'line\nbreak');
  assert.equal(parsed[1][2], "'=1+1"); // formula injection neutralised
});
