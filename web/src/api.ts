export type Role = 'owner' | 'member' | 'viewer';
export type StoryType = 'feature' | 'bug' | 'chore' | 'release';
export type StoryState = 'unscheduled' | 'unstarted' | 'started' | 'finished' | 'delivered' | 'rejected' | 'accepted';

export interface Person {
  kind: 'person';
  id: number;
  name: string;
  email: string;
  initials: string;
  username: string;
}
export interface Me extends Omit<Person, 'kind'> {
  kind: 'me';
  api_token: string;
  is_admin: boolean;
  email_notifications: boolean;
  time_zone: string;
}
export interface Project {
  id: number;
  name: string;
  description: string;
  iteration_length: number;
  week_start_day: string;
  point_scale: string;
  initial_velocity: number;
  velocity_averaged_over: number;
  bugs_and_chores_are_estimatable: boolean;
  automatic_planning: boolean;
  enable_tasks: boolean;
  public: boolean;
  archived: boolean;
  start_date: string;
  time_zone: string;
  version: number;
  current_iteration_number: number;
  current_velocity: number;
  role: Role | null;
}
export interface Membership {
  id: number;
  project_id: number;
  role: Role;
  project_color: string;
  person: Person;
}
export interface Label {
  id: number;
  project_id: number;
  name: string;
}
export interface LabelWithCounts extends Label {
  story_count: number;
  epic_id: number | null;
}
export interface Story {
  kind: 'story';
  id: number;
  project_id: number;
  name: string;
  description: string;
  story_type: StoryType;
  current_state: StoryState;
  estimate: number | null;
  position: number;
  requested_by_id: number | null;
  owner_ids: number[];
  follower_ids: number[];
  label_ids: number[];
  labels: Label[];
  deadline: string | null;
  accepted_at: string | null;
  started_at: string | null;
  planned_iteration_number: number | null;
  tasks_total: number;
  tasks_completed: number;
  comment_count: number;
  attachment_count: number;
  reviews_total: number;
  reviews_passed: number;
  blocker_count: number;
  blocked_by_story_ids: number[];
  blocking_story_ids: number[];
  url: string;
  created_at: string;
  updated_at: string;
}
export interface Task {
  id: number;
  description: string;
  complete: boolean;
  position: number;
}
export interface FileAttachment {
  id: number;
  filename: string;
  content_type: string;
  size: number;
  download_url: string;
  uploader_id: number | null;
}
export interface Comment {
  id: number;
  person_id: number | null;
  text: string;
  commit_identifier: string | null;
  commit_type: string | null;
  file_attachments: FileAttachment[];
  created_at: string;
  updated_at: string;
}
export interface Blocker {
  id: number;
  description: string;
  resolved: boolean;
  person_id: number | null;
}
export interface Review {
  id: number;
  review_type_id: number;
  review_type_name: string;
  reviewer_id: number | null;
  status: 'unstarted' | 'in_review' | 'pass' | 'revise';
}
export interface ReviewType {
  id: number;
  name: string;
  hidden: boolean;
}
export interface StoryFull extends Story {
  tasks: Task[];
  comments: Comment[];
  blockers: Blocker[];
  reviews: Review[];
}
export interface Iteration {
  number: number;
  scope: 'done' | 'current' | 'backlog';
  start: string;
  finish: string;
  length: number;
  team_strength: number;
  points: number;
  accepted_points: number;
  capacity: number | null;
  story_ids: number[];
  stories?: Story[];
}
export interface ReleaseProjection {
  story_id: number;
  iteration_number: number | null;
  projected_completion: string | null;
  behind_schedule: boolean;
}
export interface Board {
  project: Project;
  velocity: number;
  current_iteration_number: number;
  iterations: Iteration[];
  icebox_ids: number[];
  unplanned_ids: number[];
  releases: ReleaseProjection[];
  stories: Story[];
  done_iteration_count: number;
}
export interface Epic {
  id: number;
  project_id: number;
  name: string;
  description: string;
  label: Label;
  position: number;
  stories_total: number;
  stories_accepted: number;
  points_total: number;
  points_accepted: number;
  state_counts: Record<string, number>;
  comments?: Comment[];
}
export interface Activity {
  kind: string;
  guid: string;
  id: number;
  project_version: number;
  message: string;
  highlight: string;
  primary_resources: { kind: string; id: number; name: string; story_type?: string }[];
  project: { id: number; name: string };
  performed_by: Person | null;
  occurred_at: string;
}
export interface Notification {
  id: number;
  notification_type: string;
  message: string;
  context: string | null;
  performer: Person | null;
  project: { id: number; name: string } | null;
  story: { id: number; name: string; story_type: string } | null;
  read_at: string | null;
  created_at: string;
}
export interface Workspace {
  id: number;
  name: string;
  project_ids: number[];
}
export interface Webhook {
  id: number;
  url: string;
  secret: string;
  enabled: boolean;
  last_status: number | null;
  last_error: string | null;
  last_delivered_at: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: any,
  ) {
    super(body?.error ?? `Request failed (${status})`);
  }
}

type Listener = () => void;
const unauthListeners = new Set<Listener>();
export const onUnauthenticated = (fn: Listener) => {
  unauthListeners.add(fn);
  return () => {
    unauthListeners.delete(fn);
  };
};

export interface ResponseMeta {
  headers: Headers;
}

async function request<T>(method: string, path: string, body?: unknown, meta?: ResponseMeta): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api/v1${path}`, init);
  if (meta) meta.headers = res.headers;
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) unauthListeners.forEach((l) => l());
    throw new ApiError(res.status, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, meta?: ResponseMeta) => request<T>('GET', path, undefined, meta),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: (projectId: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<FileAttachment>('POST', `/projects/${projectId}/uploads`, fd);
  },
};

export const qs = (o: Record<string, unknown>) =>
  '?' +
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
