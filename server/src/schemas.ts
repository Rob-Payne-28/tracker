import { Type, type TSchema, type Static } from '@sinclair/typebox';

export const Nullable = <T extends TSchema>(t: T) => Type.Union([Type.Null(), t]); // null first: avoids AJV coercing null → 0 / ""
const Id = (description?: string) => Type.Integer({ minimum: 1, description });
const Timestamp = (description = 'ISO-8601 timestamp') => Type.String({ format: 'date-time', description });
const DateOnly = (description = 'Calendar date, YYYY-MM-DD') => Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}', description });
const Free = (description?: string) => Type.Object({}, { additionalProperties: true, description });

export const StoryTypeEnum = Type.Union(
  ['feature', 'bug', 'chore', 'release'].map((v) => Type.Literal(v)),
  { description: 'feature (estimated, delivers value), bug, chore (no direct value), or release (milestone marker)' },
);
export const StoryStateEnum = Type.Union(
  ['unscheduled', 'unstarted', 'started', 'finished', 'delivered', 'rejected', 'accepted'].map((v) => Type.Literal(v)),
  { description: '"unscheduled" means the story is in the icebox. Chores skip finished/delivered/rejected; releases only use unscheduled/unstarted/accepted.' },
);
export const RoleEnum = Type.Union(['owner', 'member', 'viewer'].map((v) => Type.Literal(v)), {
  description: 'owner: full control incl. settings & members; member: edit stories; viewer: read-only',
});
export const WeekdayEnum = Type.Union(
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((v) => Type.Literal(v)),
);

// ------------------------------------------------------------------------------------------
// Common

export const ErrorSchema = Type.Object(
  {
    kind: Type.Literal('error'),
    code: Type.String({ description: 'Machine readable error code, e.g. invalid_parameter, unauthenticated, unfound_resource' }),
    error: Type.String({ description: 'Human readable message' }),
    general_problem: Type.Optional(Type.String()),
    possible_fix: Type.Optional(Type.String()),
    validation_errors: Type.Optional(Type.Array(Type.Object({ field: Type.String(), problem: Type.String() }))),
  },
  { $id: 'Error', title: 'Error' },
);

export const Ok = Type.Object({ ok: Type.Boolean() }, { $id: 'Ok', title: 'Ok' });

export const Pagination = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 100, description: 'Maximum number of items to return' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0, description: 'Number of items to skip' })),
});

export const ProjectParams = Type.Object({ project_id: Id('Project id') });
export const StoryParams = Type.Object({ project_id: Id('Project id'), story_id: Id('Story id') });
export const IdParam = Type.Object({ id: Id() });

// ------------------------------------------------------------------------------------------
// People

export const Person = Type.Object(
  {
    kind: Type.Literal('person'),
    id: Type.Integer(),
    name: Type.String(),
    email: Type.String(),
    initials: Type.String(),
    username: Type.String({ description: 'Used for @mentions' }),
  },
  { $id: 'Person', title: 'Person' },
);

export const Me = Type.Object(
  {
    kind: Type.Literal('me'),
    id: Type.Integer(),
    name: Type.String(),
    email: Type.String(),
    initials: Type.String(),
    username: Type.String(),
    api_token: Type.String({ description: 'Send as the X-TrackerToken header to authenticate API requests' }),
    is_admin: Type.Boolean({ description: 'Instance administrator' }),
    email_notifications: Type.Boolean(),
    time_zone: Type.String(),
    created_at: Timestamp(),
    updated_at: Timestamp(),
  },
  { $id: 'Me', title: 'Me' },
);

// ------------------------------------------------------------------------------------------
// Projects

export const Project = Type.Object(
  {
    kind: Type.Literal('project'),
    id: Type.Integer(),
    name: Type.String(),
    description: Type.String(),
    iteration_length: Type.Integer({ description: 'Iteration length in weeks' }),
    week_start_day: Type.String(),
    point_scale: Type.String({ description: 'Comma separated list of allowed estimates, e.g. "0,1,2,3,5,8"' }),
    initial_velocity: Type.Integer({ description: 'Velocity used until the first iteration completes' }),
    velocity_averaged_over: Type.Integer({ description: 'Number of past iterations averaged to compute velocity' }),
    bugs_and_chores_are_estimatable: Type.Boolean(),
    automatic_planning: Type.Boolean({
      description: 'true: backlog is split into iterations automatically by velocity. false: stories are placed by planned_iteration_number.',
    }),
    enable_tasks: Type.Boolean(),
    public: Type.Boolean({ description: 'Public projects can be read by anyone, including unauthenticated users' }),
    archived: Type.Boolean(),
    start_date: DateOnly('Date of the first iteration (aligned back to week_start_day)'),
    time_zone: Type.String({ description: 'IANA time zone used for iteration boundaries' }),
    version: Type.Integer({ description: 'Incremented on every change; matches activity project_version' }),
    current_iteration_number: Type.Integer(),
    current_velocity: Type.Integer(),
    role: Nullable(RoleEnum),
    created_at: Timestamp(),
    updated_at: Timestamp(),
  },
  { $id: 'Project', title: 'Project' },
);

const projectFields = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 10000 }),
  iteration_length: Type.Integer({ minimum: 1, maximum: 4 }),
  week_start_day: WeekdayEnum,
  point_scale: Type.String({ description: 'Preset ("fibonacci", "linear", "powers_of_two") or custom comma separated list' }),
  initial_velocity: Type.Integer({ minimum: 1, maximum: 1000 }),
  velocity_averaged_over: Type.Integer({ minimum: 1, maximum: 10 }),
  bugs_and_chores_are_estimatable: Type.Boolean(),
  automatic_planning: Type.Boolean(),
  enable_tasks: Type.Boolean(),
  public: Type.Boolean(),
  archived: Type.Boolean(),
  start_date: DateOnly(),
  time_zone: Type.String(),
};
const { name: _projectName, ...projectOptional } = projectFields;
export const ProjectCreate = Type.Composite([Type.Object({ name: projectFields.name }), Type.Partial(Type.Object(projectOptional))]);
export const ProjectUpdate = Type.Partial(Type.Object(projectFields));

export const Membership = Type.Object(
  {
    kind: Type.Literal('project_membership'),
    id: Type.Integer(),
    project_id: Type.Integer(),
    role: RoleEnum,
    project_color: Type.String(),
    last_viewed_at: Nullable(Timestamp()),
    created_at: Timestamp(),
    updated_at: Timestamp(),
    person: Type.Ref('Person'),
  },
  { $id: 'Membership', title: 'Project membership' },
);

// ------------------------------------------------------------------------------------------
// Stories

export const Label = Type.Object(
  { kind: Type.Literal('label'), id: Type.Integer(), project_id: Type.Integer(), name: Type.String() },
  { $id: 'Label', title: 'Label' },
);

export const LabelWithCounts = Type.Object(
  {
    kind: Type.Literal('label'),
    id: Type.Integer(),
    project_id: Type.Integer(),
    name: Type.String(),
    story_count: Type.Integer(),
    epic_id: Nullable(Type.Integer()),
    created_at: Timestamp(),
    updated_at: Timestamp(),
  },
  { $id: 'LabelWithCounts', title: 'Label (with counts)' },
);

const storyBase = {
  kind: Type.Literal('story'),
  id: Type.Integer(),
  project_id: Type.Integer(),
  name: Type.String(),
  description: Type.String({ description: 'Markdown' }),
  story_type: StoryTypeEnum,
  current_state: StoryStateEnum,
  estimate: Nullable(Type.Number({ description: 'Points; null if unestimated' })),
  position: Type.Number({ description: 'Priority order key (lower = higher priority). Use before_id/after_id to reorder.' }),
  requested_by_id: Nullable(Type.Integer()),
  owner_ids: Type.Array(Type.Integer()),
  follower_ids: Type.Array(Type.Integer()),
  label_ids: Type.Array(Type.Integer()),
  labels: Type.Array(Type.Ref('Label')),
  deadline: Nullable(DateOnly('Release deadline (release stories only)')),
  accepted_at: Nullable(Timestamp()),
  started_at: Nullable(Timestamp()),
  planned_iteration_number: Nullable(Type.Integer({ description: 'Manual planning: iteration the story is planned for' })),
  external_id: Nullable(Type.String()),
  tasks_total: Type.Integer(),
  tasks_completed: Type.Integer(),
  comment_count: Type.Integer(),
  attachment_count: Type.Integer(),
  reviews_total: Type.Integer(),
  reviews_passed: Type.Integer(),
  blocker_count: Type.Integer({ description: 'Unresolved blockers' }),
  blocked_by_story_ids: Type.Array(Type.Integer(), { description: 'Stories referenced (#id) by unresolved blockers' }),
  blocking_story_ids: Type.Array(Type.Integer(), { description: 'Stories that this story is blocking' }),
  url: Type.String(),
  created_at: Timestamp(),
  updated_at: Timestamp(),
};
export const Story = Type.Object(storyBase, { $id: 'Story', title: 'Story' });

export const Task = Type.Object(
  {
    kind: Type.Literal('task'),
    id: Type.Integer(),
    story_id: Type.Integer(),
    description: Type.String(),
    complete: Type.Boolean(),
    position: Type.Integer(),
    created_at: Timestamp(),
    updated_at: Timestamp(),
  },
  { $id: 'Task', title: 'Task' },
);

export const Attachment = Type.Object(
  {
    kind: Type.Literal('file_attachment'),
    id: Type.Integer(),
    project_id: Type.Integer(),
    comment_id: Nullable(Type.Integer()),
    uploader_id: Nullable(Type.Integer()),
    filename: Type.String(),
    content_type: Type.String(),
    size: Type.Integer(),
    download_url: Type.String(),
    created_at: Timestamp(),
  },
  { $id: 'FileAttachment', title: 'File attachment' },
);

export const Comment = Type.Object(
  {
    kind: Type.Literal('comment'),
    id: Type.Integer(),
    project_id: Type.Integer(),
    story_id: Nullable(Type.Integer()),
    epic_id: Nullable(Type.Integer()),
    person_id: Nullable(Type.Integer()),
    text: Type.String({ description: 'Markdown. @username mentions notify people.' }),
    commit_identifier: Nullable(Type.String()),
    commit_type: Nullable(Type.String()),
    file_attachments: Type.Array(Type.Ref('FileAttachment')),
    created_at: Timestamp(),
    updated_at: Timestamp(),
  },
  { $id: 'Comment', title: 'Comment' },
);

export const Blocker = Type.Object(
  {
    kind: Type.Literal('blocker'),
    id: Type.Integer(),
    story_id: Type.Integer(),
    person_id: Nullable(Type.Integer()),
    description: Type.String({ description: 'Free text; "#123" references story 123 as the blocking story' }),
    resolved: Type.Boolean(),
    created_at: Timestamp(),
    updated_at: Timestamp(),
  },
  { $id: 'Blocker', title: 'Blocker' },
);

export const ReviewStatusEnum = Type.Union(['unstarted', 'in_review', 'pass', 'revise'].map((v) => Type.Literal(v)));
export const Review = Type.Object(
  {
    kind: Type.Literal('review'),
    id: Type.Integer(),
    story_id: Type.Integer(),
    review_type_id: Type.Integer(),
    review_type_name: Type.String(),
    reviewer_id: Nullable(Type.Integer()),
    status: ReviewStatusEnum,
    created_at: Timestamp(),
    updated_at: Timestamp(),
  },
  { $id: 'Review', title: 'Review' },
);

export const ReviewType = Type.Object(
  { kind: Type.Literal('review_type'), id: Type.Integer(), project_id: Type.Integer(), name: Type.String(), hidden: Type.Boolean(), created_at: Timestamp(), updated_at: Timestamp() },
  { $id: 'ReviewType', title: 'Review type' },
);

export const StoryFull = Type.Object(
  {
    ...storyBase,
    tasks: Type.Array(Type.Ref('Task')),
    comments: Type.Array(Type.Ref('Comment')),
    blockers: Type.Array(Type.Ref('Blocker')),
    reviews: Type.Array(Type.Ref('Review')),
  },
  { $id: 'StoryFull', title: 'Story (with tasks, comments, blockers and reviews)' },
);

const LabelRef = Type.Union([Type.String(), Type.Object({ id: Type.Optional(Type.Integer()), name: Type.Optional(Type.String()) })], {
  description: 'Label name (created if missing) or {id} / {name}',
});

const storyWritable = {
  name: Type.String({ minLength: 1, maxLength: 5000 }),
  description: Type.String({ maxLength: 100000 }),
  story_type: StoryTypeEnum,
  current_state: StoryStateEnum,
  estimate: Nullable(Type.Number()),
  requested_by_id: Nullable(Type.Integer()),
  owner_ids: Type.Array(Type.Integer(), { description: 'Replaces the owner list (order is significant)' }),
  follower_ids: Type.Array(Type.Integer(), { description: 'Replaces the follower list' }),
  label_ids: Type.Array(Type.Integer(), { description: 'Replaces labels (combined with `labels`)' }),
  labels: Type.Array(LabelRef, { description: 'Replaces labels; names that do not exist are created' }),
  deadline: Nullable(Type.String({ description: 'Release deadline (YYYY-MM-DD)' })),
  accepted_at: Nullable(Type.String({ description: 'Override acceptance time when accepting (e.g. for imports)' })),
  planned_iteration_number: Nullable(Type.Integer({ minimum: 1 })),
  external_id: Nullable(Type.String({ maxLength: 255 })),
  before_id: Nullable(Type.Integer({ description: 'Place the story immediately before (above) this story' })),
  after_id: Nullable(Type.Integer({ description: 'Place the story immediately after (below) this story' })),
};
const { name: _storyName, ...storyOptional } = storyWritable;
export const StoryCreate = Type.Composite([
  Type.Object({ name: storyWritable.name }),
  Type.Partial(Type.Object(storyOptional)),
  Type.Object({
    tasks: Type.Optional(
      Type.Array(Type.Object({ description: Type.String(), complete: Type.Optional(Type.Boolean()) }), { description: 'Tasks to create with the story' }),
    ),
  }),
]);
export const StoryUpdate = Type.Composite([
  Type.Partial(Type.Object(storyWritable)),
  Type.Object({ project_id: Type.Optional(Type.Integer({ description: 'Move the story to another project you are a member of' })) }),
]);

// ------------------------------------------------------------------------------------------
// Epics

export const Epic = Type.Object(
  {
    kind: Type.Literal('epic'),
    id: Type.Integer(),
    project_id: Type.Integer(),
    name: Type.String(),
    description: Type.String(),
    label: Type.Ref('Label'),
    position: Type.Number(),
    stories_total: Type.Integer(),
    stories_accepted: Type.Integer(),
    points_total: Type.Number(),
    points_accepted: Type.Number(),
    state_counts: Free('Number of stories per state'),
    comments: Type.Optional(Type.Array(Type.Ref('Comment'))),
    url: Type.String(),
    created_at: Timestamp(),
    updated_at: Timestamp(),
  },
  { $id: 'Epic', title: 'Epic' },
);

// ------------------------------------------------------------------------------------------
// Iterations

export const Iteration = Type.Object(
  {
    kind: Type.Literal('iteration'),
    number: Type.Integer(),
    project_id: Type.Integer(),
    scope: Type.Union([Type.Literal('done'), Type.Literal('current'), Type.Literal('backlog')]),
    start: DateOnly(),
    finish: DateOnly('Exclusive finish date (start of the next iteration)'),
    length: Type.Integer({ description: 'Weeks' }),
    team_strength: Type.Number({ description: '1.0 = 100%' }),
    points: Type.Number(),
    accepted_points: Type.Number(),
    capacity: Nullable(Type.Number({ description: 'Projected point capacity (velocity × strength × length)' })),
    story_ids: Type.Array(Type.Integer()),
    stories: Type.Optional(Type.Array(Type.Ref('Story'))),
  },
  { $id: 'Iteration', title: 'Iteration' },
);

export const ReleaseProjection = Type.Object(
  {
    story_id: Type.Integer(),
    iteration_number: Nullable(Type.Integer()),
    projected_completion: Nullable(DateOnly()),
    behind_schedule: Type.Boolean(),
  },
  { $id: 'ReleaseProjection', title: 'Release projection' },
);

// ------------------------------------------------------------------------------------------
// Activity, notifications, misc

export const Activity = Type.Object(
  {
    kind: Type.String({ description: 'e.g. story_create_activity, story_update_activity, comment_create_activity' }),
    guid: Type.String({ description: '"<project_id>_<project_version>"' }),
    id: Type.Integer(),
    project_version: Type.Integer(),
    message: Type.String(),
    highlight: Type.String({ description: 'The verb of the message, e.g. "started"' }),
    changes: Type.Array(Free('{kind, change_type, id, name, story_type, original_values, new_values}')),
    primary_resources: Type.Array(Free('{kind, id, name, story_type, url}')),
    project: Type.Object({ kind: Type.Literal('project'), id: Type.Integer(), name: Type.String() }),
    performed_by: Nullable(Type.Ref('Person')),
    occurred_at: Timestamp(),
  },
  { $id: 'Activity', title: 'Activity' },
);

export const Notification = Type.Object(
  {
    kind: Type.Literal('notification'),
    id: Type.Integer(),
    notification_type: Type.String({ description: 'mention, owner_added, comment, story_delivered, story_accepted, story_rejected, review_requested, ...' }),
    message: Type.String(),
    context: Nullable(Type.String()),
    performer: Nullable(Type.Ref('Person')),
    project: Nullable(Type.Object({ kind: Type.Literal('project'), id: Type.Integer(), name: Type.String() })),
    story: Nullable(Type.Object({ kind: Type.Literal('story'), id: Type.Integer(), name: Type.String(), story_type: Type.String() })),
    epic_id: Nullable(Type.Integer()),
    read_at: Nullable(Timestamp()),
    created_at: Timestamp(),
  },
  { $id: 'Notification', title: 'Notification' },
);

export const Workspace = Type.Object(
  { kind: Type.Literal('workspace'), id: Type.Integer(), name: Type.String(), project_ids: Type.Array(Type.Integer()), created_at: Timestamp(), updated_at: Timestamp() },
  { $id: 'Workspace', title: 'Workspace' },
);

export const Webhook = Type.Object(
  {
    kind: Type.Literal('webhook'),
    id: Type.Integer(),
    project_id: Type.Integer(),
    url: Type.String(),
    secret: Type.String({ description: 'HMAC-SHA256 key; deliveries carry X-Tracker-Signature: sha256=<hex>' }),
    enabled: Type.Boolean(),
    last_status: Nullable(Type.Integer()),
    last_error: Nullable(Type.String()),
    last_delivered_at: Nullable(Timestamp()),
    created_at: Timestamp(),
    updated_at: Timestamp(),
  },
  { $id: 'Webhook', title: 'Webhook' },
);

export const IterationOverride = Type.Object(
  {
    kind: Type.Literal('iteration_override'),
    project_id: Type.Integer(),
    number: Type.Integer(),
    length: Nullable(Type.Integer({ description: 'Weeks; null = project default' })),
    team_strength: Type.Number({ description: '0.0–5.0; 1.0 = 100%' }),
  },
  { $id: 'IterationOverride', title: 'Iteration override' },
);

export type StoryCreateT = Static<typeof StoryCreate>;
export type StoryUpdateT = Static<typeof StoryUpdate>;

export const allSchemas = [
  ErrorSchema, Ok, Person, Me, Project, Membership, Label, LabelWithCounts, Story, Task, Attachment, Comment, Blocker,
  Review, ReviewType, StoryFull, Epic, Iteration, ReleaseProjection, Activity, Notification, Workspace, Webhook,
  IterationOverride,
];

export const ref = (s: TSchema | string) => Type.Ref(typeof s === 'string' ? s : s.$id!);
