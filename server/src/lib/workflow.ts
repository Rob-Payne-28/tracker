/**
 * The story workflow, declared in one place. Story validation, iteration planning, commit
 * integration and (via a contract test) the web UI all derive their rules from this table, so
 * changing the workflow — e.g. adding a state or a story type — is a change here plus a migration.
 */

export const STORY_TYPES = ['feature', 'bug', 'chore', 'release'] as const;
export const STORY_STATES = ['unscheduled', 'unstarted', 'started', 'finished', 'delivered', 'rejected', 'accepted'] as const;
export type StoryType = (typeof STORY_TYPES)[number];
export type StoryState = (typeof STORY_STATES)[number];

export interface StoryTypeRules {
  /** States a story of this type may be in. */
  states: readonly StoryState[];
  /** Whether estimates count: 'always', 'never', or only when the project allows it for bugs/chores. */
  estimable: 'always' | 'never' | 'project_setting';
  /** Features must be estimated before work starts. */
  requiresEstimateToStart: boolean;
  /** The state a story falls back to when its type changes and the old state is not allowed. */
  fallbackState: StoryState;
}

export const TYPE_RULES: Record<StoryType, StoryTypeRules> = {
  feature: { states: STORY_STATES, estimable: 'always', requiresEstimateToStart: true, fallbackState: 'unstarted' },
  bug: { states: STORY_STATES, estimable: 'project_setting', requiresEstimateToStart: false, fallbackState: 'unstarted' },
  chore: { states: ['unscheduled', 'unstarted', 'started', 'accepted'], estimable: 'project_setting', requiresEstimateToStart: false, fallbackState: 'started' },
  release: { states: ['unscheduled', 'unstarted', 'accepted'], estimable: 'never', requiresEstimateToStart: false, fallbackState: 'unstarted' },
};

/** Work has begun (used for started_at and the estimate requirement). */
export const STARTED_STATES: ReadonlySet<string> = new Set(['started', 'finished', 'delivered', 'rejected', 'accepted']);
/** In flight: always planned into the current iteration. */
export const IN_PROGRESS_STATES: ReadonlySet<string> = new Set(['started', 'finished', 'delivered', 'rejected']);
/** Waiting to be worked on, in priority order. */
export const UNSTARTED_STATES: ReadonlySet<string> = new Set(['unstarted', 'planned']);

/** Forward progress order; integrations never move a story backwards along it. */
export const PROGRESS_ORDER: readonly StoryState[] = ['unscheduled', 'unstarted', 'started', 'rejected', 'finished', 'delivered', 'accepted'];

export function isAllowedState(type: StoryType, state: string): state is StoryState {
  return (TYPE_RULES[type].states as readonly string[]).includes(state);
}

export function isEstimable(type: StoryType, bugsAndChoresEstimable: boolean | number): boolean {
  const e = TYPE_RULES[type].estimable;
  return e === 'always' || (e === 'project_setting' && !!bugsAndChoresEstimable);
}

export interface WorkflowAction {
  label: string;
  to: StoryState;
  kind: 'start' | 'finish' | 'deliver' | 'accept' | 'reject' | 'restart';
}

/** The buttons shown for a story ("Start", "Finish", "Accept"/"Reject", …). */
export function nextActions(type: StoryType, state: StoryState): WorkflowAction[] {
  switch (state) {
    case 'unscheduled':
    case 'unstarted':
      return type === 'release' ? [{ label: 'Finish', to: 'accepted', kind: 'finish' }] : [{ label: 'Start', to: 'started', kind: 'start' }];
    case 'started':
      return type === 'chore' ? [{ label: 'Finish', to: 'accepted', kind: 'finish' }] : [{ label: 'Finish', to: 'finished', kind: 'finish' }];
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

/** Past-tense verb used in activity messages for a transition. */
export function transitionVerb(from: StoryState, to: StoryState): string {
  if (from === 'rejected' && to === 'started') return 'restarted';
  if (from === 'unscheduled' && to === 'unstarted') return 'moved into the backlog';
  if (to === 'unscheduled') return 'moved into the icebox';
  return to;
}

/** Every action offered by nextActions() must be a legal state for the type. */
export function validateWorkflow(): string[] {
  const problems: string[] = [];
  for (const type of STORY_TYPES) {
    for (const state of TYPE_RULES[type].states) {
      for (const a of nextActions(type, state)) {
        if (!isAllowedState(type, a.to)) problems.push(`${type}/${state}: action ${a.kind} leads to illegal state ${a.to}`);
      }
    }
    if (!isAllowedState(type, TYPE_RULES[type].fallbackState)) problems.push(`${type}: fallback state is not allowed`);
  }
  return problems;
}
