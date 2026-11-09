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

const KEYS = new Set([
  'label', 'type', 'state', 'owner', 'requester', 'follower', 'reviewer', 'mywork', 'id', 'estimate', 'epic',
  'is', 'has', 'name', 'description', 'created_since', 'created_before', 'updated_since', 'updated_before',
  'accepted_since', 'accepted_before', 'includedone',
]);
const ALIASES: Record<string, string> = { story_type: 'type', owned_by: 'owner', requested_by: 'requester', labels: 'label', is_blocked: 'is' };

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { filters: [], terms: [], includeDone: false };
  const re = /(-?)([a-z_]+):(?:"([^"]*)"|(\S+))|(-?)"([^"]*)"|(\S+)/gi;
  for (const m of q.matchAll(re)) {
    if (m[2]) {
      let key = m[2].toLowerCase();
      key = ALIASES[key] ?? key;
      const raw = m[3] ?? m[4] ?? '';
      if (!KEYS.has(key)) {
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

export function searchStories(ctx: Ctx, project: Project, query: string, userId: number | null): StoryJson[] {
  const parsed = parseQuery(query);
  const db = ctx.db;
  const pid = project.id;

  // Lookup tables
  const people = db.all(
    `SELECT u.id, lower(u.username) AS username, lower(u.initials) AS initials, lower(u.name) AS name, lower(u.email) AS email
       FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.project_id = ?`,
    [pid],
  );
  const personIds = (v: string): number[] => {
    const s = v.toLowerCase().replace(/^@/, '');
    if (s === 'me') {
      if (!userId) throw badRequest('"me" requires authentication.');
      return [userId];
    }
    return people.filter((p) => p.username === s || p.initials === s || p.name === s || p.email === s || p.name.split(' ')[0] === s).map((p) => p.id);
  };

  // Text matches across comments/tasks are computed in SQL for efficiency.
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

  const rows = storyRows(ctx, pid);
  let stories = hydrate(ctx, rows);
  if (!parsed.includeDone) stories = stories.filter((s) => s.current_state !== 'accepted');

  for (const term of parsed.terms) {
    const set = textIds(term.text);
    stories = stories.filter((s) => set.has(s.id) !== term.negate);
  }

  const reviewsBy = new Map<number, Set<number>>();
  if (parsed.filters.some((f) => f.key === 'reviewer')) {
    for (const r of db.all('SELECT r.story_id, r.reviewer_id FROM reviews r JOIN stories s ON s.id = r.story_id WHERE s.project_id = ?', [pid])) {
      if (!reviewsBy.has(r.story_id)) reviewsBy.set(r.story_id, new Set());
      reviewsBy.get(r.story_id)!.add(r.reviewer_id);
    }
  }

  for (const f of parsed.filters) {
    const vals = f.values.map((v) => v.toLowerCase());
    let pred: (s: StoryJson) => boolean;
    const dateCmp = (field: 'created_at' | 'updated_at' | 'accepted_at', dir: 'since' | 'before') => (s: StoryJson) => {
      const v = s[field];
      if (!v) return false;
      return vals.some((d) => (dir === 'since' ? v.slice(0, 10) >= d : v.slice(0, 10) < d));
    };
    switch (f.key) {
      case 'label':
        pred = (s) => s.labels.some((l) => vals.includes(l.name.toLowerCase()));
        break;
      case 'epic': {
        const labelIds = new Set(
          db
            .all('SELECT e.label_id, lower(e.name) AS name, lower(l.name) AS lname FROM epics e JOIN labels l ON l.id = e.label_id WHERE e.project_id = ?', [pid])
            .filter((e) => vals.includes(e.name) || vals.includes(e.lname))
            .map((e) => e.label_id as number),
        );
        pred = (s) => s.label_ids.some((id) => labelIds.has(id));
        break;
      }
      case 'type':
        pred = (s) => vals.includes(s.story_type);
        break;
      case 'state':
        pred = (s) => vals.includes(s.current_state) || (vals.includes('done') && s.current_state === 'accepted');
        break;
      case 'owner': {
        const set = new Set(vals.flatMap(personIds));
        pred = (s) => s.owner_ids.some((id) => set.has(id));
        break;
      }
      case 'requester': {
        const set = new Set(vals.flatMap(personIds));
        pred = (s) => s.requested_by_id != null && set.has(s.requested_by_id);
        break;
      }
      case 'follower': {
        const set = new Set(vals.flatMap(personIds));
        pred = (s) => s.follower_ids.some((id) => set.has(id));
        break;
      }
      case 'reviewer': {
        const set = new Set(vals.flatMap(personIds));
        pred = (s) => [...(reviewsBy.get(s.id) ?? [])].some((id) => set.has(id));
        break;
      }
      case 'mywork': {
        const set = new Set(vals.flatMap(personIds));
        pred = (s) => s.current_state !== 'accepted' && s.owner_ids.some((id) => set.has(id));
        break;
      }
      case 'id': {
        const set = new Set(vals.map((v) => Number(v.replace('#', ''))));
        pred = (s) => set.has(s.id);
        break;
      }
      case 'estimate':
        pred = (s) => vals.some((v) => (['none', 'unestimated', '-1'].includes(v) ? s.estimate == null : s.estimate === Number(v)));
        break;
      case 'is':
        pred = (s) =>
          vals.some((v) => {
            switch (v) {
              case 'blocked': return s.blocker_count > 0;
              case 'blocking': return s.blocking_story_ids.length > 0;
              case 'unestimated': return s.story_type === 'feature' && s.estimate == null;
              case 'estimated': return s.estimate != null;
              default: throw badRequest(`Unknown is: value "${v}".`);
            }
          });
        break;
      case 'has':
        pred = (s) =>
          vals.some((v) => {
            switch (v) {
              case 'attachment': case 'attachments': case 'file': return s.attachment_count > 0;
              case 'comment': case 'comments': return s.comment_count > 0;
              case 'task': case 'tasks': return s.tasks_total > 0;
              case 'blocker': case 'blockers': return s.blocker_count > 0;
              case 'description': return s.description.trim() !== '';
              case 'label': case 'labels': return s.labels.length > 0;
              case 'owner': case 'owners': return s.owner_ids.length > 0;
              case 'review': case 'reviews': return s.reviews_total > 0;
              case 'deadline': return !!s.deadline;
              default: throw badRequest(`Unknown has: value "${v}".`);
            }
          });
        break;
      case 'name':
        pred = (s) => vals.every((v) => s.name.toLowerCase().includes(v));
        break;
      case 'description':
        pred = (s) => vals.every((v) => s.description.toLowerCase().includes(v));
        break;
      case 'created_since': pred = dateCmp('created_at', 'since'); break;
      case 'created_before': pred = dateCmp('created_at', 'before'); break;
      case 'updated_since': pred = dateCmp('updated_at', 'since'); break;
      case 'updated_before': pred = dateCmp('updated_at', 'before'); break;
      case 'accepted_since': pred = dateCmp('accepted_at', 'since'); break;
      case 'accepted_before': pred = dateCmp('accepted_at', 'before'); break;
      default:
        continue;
    }
    stories = stories.filter((s) => pred(s) !== f.negate);
  }
  return stories;
}
