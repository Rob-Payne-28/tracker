/**
 * Search query language.
 *
 *   free text            matches story name, description, comments, tasks and labels (all words must match)
 *   "exact phrase"       phrase match
 *   label:ui             stories with label (comma separates alternatives: label:ui,api)
 *   type:bug             feature | bug | chore | release
 *   state:started        any story state; "state:done" == accepted
 *   owner:jd             owner by username, initials, or "me"
 *   requester:me         requested by
 *   follower:me          followed by
 *   reviewer:me          has a review assigned to
 *   mywork:me            owned by me and not accepted
 *   id:12,15             story ids
 *   estimate:3           estimate (use "none" for unestimated)
 *   epic:"Onboarding"    stories carrying the epic's label
 *   is:blocked | is:blocking | is:unestimated | is:estimated
 *   has:attachment | has:comment | has:task | has:blocker | has:description | has:label | has:owner | has:review | has:deadline
 *   name:login           text in the name only
 *   description:token    text in the description only
 *   created_since:2026-01-01   created_before:   updated_since:   updated_before:
 *   accepted_since:      accepted_before:
 *   includedone:true     include accepted stories (excluded by default)
 *
 * Prefix any filter with "-" to negate it, e.g. -label:wontfix.
 */
import type { Ctx } from './context.js';
import type { Project } from './projects.js';
import { hydrate, storyRows, type StoryJson } from './stories.js';
import { badRequest } from '../lib/errors.js';

export interface Filter {
  key: string;
  values: string[];
  negate: boolean;
}

export interface ParsedQuery {
  filters: Filter[];
  terms: { text: string; negate: boolean }[];
  includeDone: boolean;
}

const ALIASES: Record<string, string> = { story_type: 'type', owned_by: 'owner', requested_by: 'requester', labels: 'label', is_blocked: 'is' };

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { filters: [], terms: [], includeDone: false };
  const re = /(-?)([a-z_]+):(?:"([^"]*)"|(\S+))|(-?)"([^"]*)"|(\S+)/gi;
  for (const m of q.matchAll(re)) {
    if (m[2]) {
      let key = m[2].toLowerCase();
      key = ALIASES[key] ?? key;
      const raw = m[3] ?? m[4] ?? '';
      if (!(key in FILTERS) && key !== 'includedone') {
        out.terms.push({ text: m[0].replace(/^-/, ''), negate: m[1] === '-' });
        continue;
      }
      if (key === 'includedone') {
        out.includeDone = raw.toLowerCase() === 'true';
        continue;
      }
      const values = m[3] !== undefined ? [raw] : raw.split(',').filter(Boolean);
      out.filters.push({ key, values: values.map((v) => v.trim()), negate: m[1] === '-' });
    } else if (m[6] !== undefined) {
      if (m[6].trim()) out.terms.push({ text: m[6], negate: m[5] === '-' });
    } else if (m[7]) {
      const t = m[7];
      if (t.startsWith('-') && t.length > 1) out.terms.push({ text: t.slice(1), negate: true });
      else out.terms.push({ text: t, negate: false });
    }
  }
  // Explicitly asking for accepted stories or specific ids implies includedone.
  if (out.filters.some((f) => !f.negate && (f.key === 'id' || (f.key === 'state' && f.values.some((v) => ['accepted', 'done'].includes(v.toLowerCase())))) || f.key.startsWith('accepted_'))) {
    out.includeDone = true;
  }
  return out;
}

export interface SearchResult {
  stories: StoryJson[];
  total_points: number;
  total_points_completed: number;
  epics: any[];
  query: string;
}

// ---------------------------------------------------------------------------------------------
// Filter registry. Each filter turns its (lower-cased) values into a story predicate. To add a
// filter, register it here or call registerSearchFilter() — parsing, negation (`-key:`), comma
// alternatives and documentation of unknown keys all follow automatically.

export interface SearchContext {
  ctx: Ctx;
  project: Project;
  userId: number | null;
  /** Resolve "me", a username, initials, a name, first name or email to member ids. */
  personIds(value: string): number[];
  /** story id → reviewer ids (loaded lazily, once per search). */
  reviewers(): Map<number, Set<number>>;
}

export type StoryPredicate = (s: StoryJson) => boolean;
export type FilterHandler = (values: string[], sc: SearchContext) => StoryPredicate;

const peopleFilter =
  (get: (s: StoryJson, sc: SearchContext) => number[]): FilterHandler =>
  (vals, sc) => {
    const set = new Set(vals.flatMap((v) => sc.personIds(v)));
    return (s) => get(s, sc).some((id) => set.has(id));
  };

const dateFilter =
  (field: 'created_at' | 'updated_at' | 'accepted_at', dir: 'since' | 'before'): FilterHandler =>
  (vals) =>
  (s) => {
    const v = s[field];
    if (!v) return false;
    return vals.some((d) => (dir === 'since' ? v.slice(0, 10) >= d : v.slice(0, 10) < d));
  };

const IS_VALUES: Record<string, StoryPredicate> = {
  blocked: (s) => s.blocker_count > 0,
  blocking: (s) => s.blocking_story_ids.length > 0,
  unestimated: (s) => s.story_type === 'feature' && s.estimate == null,
  estimated: (s) => s.estimate != null,
};

const HAS_VALUES: Record<string, StoryPredicate> = {
  attachment: (s) => s.attachment_count > 0,
  comment: (s) => s.comment_count > 0,
  task: (s) => s.tasks_total > 0,
  blocker: (s) => s.blocker_count > 0,
  description: (s) => s.description.trim() !== '',
  label: (s) => s.labels.length > 0,
  owner: (s) => s.owner_ids.length > 0,
  review: (s) => s.reviews_total > 0,
  deadline: (s) => !!s.deadline,
};
const HAS_ALIASES: Record<string, string> = { attachments: 'attachment', file: 'attachment', comments: 'comment', tasks: 'task', blockers: 'blocker', labels: 'label', owners: 'owner', reviews: 'review' };

const lookupValue = (table: Record<string, StoryPredicate>, key: string, v: string, aliases: Record<string, string> = {}) => {
  const pred = table[aliases[v] ?? v];
  if (!pred) throw badRequest(`Unknown ${key}: value "${v}". Use one of: ${Object.keys(table).join(', ')}.`);
  return pred;
};

const FILTERS: Record<string, FilterHandler> = {
  label: (vals) => (s) => s.labels.some((l) => vals.includes(l.name.toLowerCase())),
  epic: (vals, sc) => {
    const labelIds = new Set(
      sc.ctx.db
        .all('SELECT e.label_id, lower(e.name) AS name, lower(l.name) AS lname FROM epics e JOIN labels l ON l.id = e.label_id WHERE e.project_id = ?', [sc.project.id])
        .filter((e) => vals.includes(e.name) || vals.includes(e.lname))
        .map((e) => e.label_id as number),
    );
    return (s) => s.label_ids.some((id) => labelIds.has(id));
  },
  type: (vals) => (s) => vals.includes(s.story_type),
  state: (vals) => (s) => vals.includes(s.current_state) || (vals.includes('done') && s.current_state === 'accepted'),
  owner: peopleFilter((s) => s.owner_ids),
  requester: peopleFilter((s) => (s.requested_by_id != null ? [s.requested_by_id] : [])),
  follower: peopleFilter((s) => s.follower_ids),
  reviewer: peopleFilter((s, sc) => [...(sc.reviewers().get(s.id) ?? [])]),
  mywork: (vals, sc) => {
    const owned = peopleFilter((s) => s.owner_ids)(vals, sc);
    return (s) => s.current_state !== 'accepted' && owned(s);
  },
  id: (vals) => {
    const set = new Set(vals.map((v) => Number(v.replace('#', ''))));
    return (s) => set.has(s.id);
  },
  estimate: (vals) => (s) => vals.some((v) => (['none', 'unestimated', '-1'].includes(v) ? s.estimate == null : s.estimate === Number(v))),
  is: (vals) => {
    const preds = vals.map((v) => lookupValue(IS_VALUES, 'is', v));
    return (s) => preds.some((p) => p(s));
  },
  has: (vals) => {
    const preds = vals.map((v) => lookupValue(HAS_VALUES, 'has', v, HAS_ALIASES));
    return (s) => preds.some((p) => p(s));
  },
  name: (vals) => (s) => vals.every((v) => s.name.toLowerCase().includes(v)),
  description: (vals) => (s) => vals.every((v) => s.description.toLowerCase().includes(v)),
  created_since: dateFilter('created_at', 'since'),
  created_before: dateFilter('created_at', 'before'),
  updated_since: dateFilter('updated_at', 'since'),
  updated_before: dateFilter('updated_at', 'before'),
  accepted_since: dateFilter('accepted_at', 'since'),
  accepted_before: dateFilter('accepted_at', 'before'),
};

/** Extension point: add (or override) a search filter, e.g. registerSearchFilter('priority', …). */
export function registerSearchFilter(key: string, handler: FilterHandler) {
  if (!/^[a-z_]+$/.test(key)) throw new Error(`Invalid filter key "${key}"`);
  FILTERS[key] = handler;
}

export const searchFilterKeys = () => Object.keys(FILTERS);

export function searchStories(ctx: Ctx, project: Project, query: string, userId: number | null): StoryJson[] {
  const parsed = parseQuery(query);
  const db = ctx.db;
  const pid = project.id;

  const people = db.all(
    `SELECT u.id, lower(u.username) AS username, lower(u.initials) AS initials, lower(u.name) AS name, lower(u.email) AS email
       FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.project_id = ?`,
    [pid],
  );
  let reviewerCache: Map<number, Set<number>> | null = null;
  const sc: SearchContext = {
    ctx,
    project,
    userId,
    personIds: (v) => {
      const s = v.toLowerCase().replace(/^@/, '');
      if (s === 'me') {
        if (!userId) throw badRequest('"me" requires authentication.');
        return [userId];
      }
      return people.filter((p) => p.username === s || p.initials === s || p.name === s || p.email === s || p.name.split(' ')[0] === s).map((p) => p.id);
    },
    reviewers: () => {
      if (!reviewerCache) {
        reviewerCache = new Map();
        for (const r of db.all('SELECT r.story_id, r.reviewer_id FROM reviews r JOIN stories s ON s.id = r.story_id WHERE s.project_id = ?', [pid])) {
          if (!reviewerCache.has(r.story_id)) reviewerCache.set(r.story_id, new Set());
          reviewerCache.get(r.story_id)!.add(r.reviewer_id);
        }
      }
      return reviewerCache;
    },
  };

  // Text matches across comments/tasks/labels are computed in SQL for efficiency.
  const textIds = (term: string) =>
    new Set(
      db
        .all(
          `SELECT s.id FROM stories s WHERE s.project_id = $pid AND (
             instr(lower(s.name), $t) > 0 OR instr(lower(s.description), $t) > 0
             OR EXISTS (SELECT 1 FROM comments c WHERE c.story_id = s.id AND instr(lower(c.text), $t) > 0)
             OR EXISTS (SELECT 1 FROM tasks k WHERE k.story_id = s.id AND instr(lower(k.description), $t) > 0)
             OR EXISTS (SELECT 1 FROM story_labels sl JOIN labels l ON l.id = sl.label_id WHERE sl.story_id = s.id AND instr(lower(l.name), $t) > 0)
             OR CAST(s.id AS TEXT) = $t OR ('#' || s.id) = $t)`,
          { pid, t: term.toLowerCase() },
        )
        .map((r) => r.id as number),
    );

  let stories = hydrate(ctx, storyRows(ctx, pid));
  if (!parsed.includeDone) stories = stories.filter((s) => s.current_state !== 'accepted');

  for (const term of parsed.terms) {
    const set = textIds(term.text);
    stories = stories.filter((s) => set.has(s.id) !== term.negate);
  }
  for (const f of parsed.filters) {
    const handler = FILTERS[f.key];
    if (!handler) continue;
    const pred = handler(f.values.map((v) => v.toLowerCase()), sc);
    stories = stories.filter((s) => pred(s) !== f.negate);
  }
  return stories;
}
