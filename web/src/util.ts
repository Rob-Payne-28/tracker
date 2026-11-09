import type { Project, Story } from './api';

export function storyPoints(s: Pick<Story, 'story_type' | 'estimate'>, p: Pick<Project, 'bugs_and_chores_are_estimatable'>) {
  if (s.estimate == null) return 0;
  if (s.story_type === 'feature') return s.estimate;
  if ((s.story_type === 'bug' || s.story_type === 'chore') && p.bugs_and_chores_are_estimatable) return s.estimate;
  return 0;
}

export function isEstimatable(type: string, p: Pick<Project, 'bugs_and_chores_are_estimatable'>) {
  return type === 'feature' || ((type === 'bug' || type === 'chore') && p.bugs_and_chores_are_estimatable);
}

export const pointScale = (p: Pick<Project, 'point_scale'>) => p.point_scale.split(',').map(Number);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Jan" from YYYY-MM-DD */
export function shortDate(d: string) {
  const [, m, day] = d.slice(0, 10).split('-').map(Number);
  return `${day} ${MONTHS[m - 1]}`;
}

export function addDays(d: string, n: number) {
  const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function timeAgo(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fullTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fileSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function savePref(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/** Next workflow actions for a story, Tracker style. */
export function stateActions(s: Pick<Story, 'story_type' | 'current_state'>): { label: string; to: Story['current_state']; kind: string }[] {
  const t = s.story_type;
  switch (s.current_state) {
    case 'unscheduled':
    case 'unstarted':
      return t === 'release' ? [{ label: 'Finish', to: 'accepted', kind: 'finish' }] : [{ label: 'Start', to: 'started', kind: 'start' }];
    case 'started':
      return t === 'chore' ? [{ label: 'Finish', to: 'accepted', kind: 'finish' }] : [{ label: 'Finish', to: 'finished', kind: 'finish' }];
    case 'finished':
      return [{ label: 'Deliver', to: 'delivered', kind: 'deliver' }];
    case 'delivered':
      return [
        { label: 'Accept', to: 'accepted', kind: 'accept' },
        { label: 'Reject', to: 'rejected', kind: 'reject' },
      ];
    case 'rejected':
      return [{ label: 'Restart', to: 'started', kind: 'restart' }];
    default:
      return [];
  }
}

export const STATES_FOR: Record<string, Story['current_state'][]> = {
  feature: ['unscheduled', 'unstarted', 'started', 'finished', 'delivered', 'rejected', 'accepted'],
  bug: ['unscheduled', 'unstarted', 'started', 'finished', 'delivered', 'rejected', 'accepted'],
  chore: ['unscheduled', 'unstarted', 'started', 'accepted'],
  release: ['unscheduled', 'unstarted', 'accepted'],
};
