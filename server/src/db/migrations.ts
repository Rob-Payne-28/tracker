/**
 * Schema migrations. Each entry is applied once, in order, tracked by PRAGMA user_version.
 * Never edit an existing entry once released; append a new one instead.
 */
export const migrations: string[] = [
  /* 1: initial schema */ `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  initials TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  api_token TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  invite_token TEXT UNIQUE,
  reset_token TEXT UNIQUE,
  reset_expires_at TEXT,
  email_notifications INTEGER NOT NULL DEFAULT 1,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  iteration_length INTEGER NOT NULL DEFAULT 1,
  week_start_day TEXT NOT NULL DEFAULT 'Monday',
  point_scale TEXT NOT NULL DEFAULT '0,1,2,3,5,8',
  initial_velocity INTEGER NOT NULL DEFAULT 10,
  velocity_averaged_over INTEGER NOT NULL DEFAULT 3,
  bugs_and_chores_are_estimatable INTEGER NOT NULL DEFAULT 0,
  automatic_planning INTEGER NOT NULL DEFAULT 1,
  enable_tasks INTEGER NOT NULL DEFAULT 1,
  public INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memberships (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','member','viewer')),
  project_color TEXT NOT NULL DEFAULT '#2b6cb0',
  last_viewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, user_id)
);

CREATE TABLE stories (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  story_type TEXT NOT NULL CHECK (story_type IN ('feature','bug','chore','release')),
  current_state TEXT NOT NULL CHECK (current_state IN ('unscheduled','unstarted','planned','started','finished','delivered','rejected','accepted')),
  estimate REAL,
  position REAL NOT NULL,
  requested_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deadline TEXT,
  accepted_at TEXT,
  started_at TEXT,
  planned_iteration_number INTEGER,
  external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX stories_project_position ON stories(project_id, position);
CREATE INDEX stories_project_state ON stories(project_id, current_state);

CREATE TABLE story_owners (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (story_id, user_id)
);
CREATE INDEX story_owners_user ON story_owners(user_id);

CREATE TABLE story_followers (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (story_id, user_id)
);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX labels_project_name ON labels(project_id, name COLLATE NOCASE);

CREATE TABLE story_labels (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (story_id, label_id)
);
CREATE INDEX story_labels_label ON story_labels(label_id);

CREATE TABLE epics (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL UNIQUE REFERENCES labels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_story ON tasks(story_id);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  story_id INTEGER REFERENCES stories(id) ON DELETE CASCADE,
  epic_id INTEGER REFERENCES epics(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text TEXT NOT NULL DEFAULT '',
  commit_identifier TEXT,
  commit_type TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX comments_story ON comments(story_id);
CREATE INDEX comments_epic ON comments(epic_id);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX attachments_comment ON attachments(comment_id);

CREATE TABLE blockers (
  id INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX blockers_story ON blockers(story_id);

CREATE TABLE iteration_overrides (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  length INTEGER,
  team_strength REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, number)
);

CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version INTEGER NOT NULL,
  performed_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  highlight TEXT NOT NULL,
  message TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '[]',
  primary_resources TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL
);
CREATE INDEX activities_project ON activities(project_id, id);
CREATE INDEX activities_performer ON activities(performed_by_id, id);

CREATE TABLE activity_stories (
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  story_id INTEGER NOT NULL,
  PRIMARY KEY (activity_id, story_id)
);
CREATE INDEX activity_stories_story ON activity_stories(story_id, activity_id);

CREATE TABLE story_transitions (
  id INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  performed_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX story_transitions_story ON story_transitions(story_id);
CREATE INDEX story_transitions_project ON story_transitions(project_id, occurred_at);

CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status INTEGER,
  last_error TEXT,
  last_delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  performer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  story_id INTEGER REFERENCES stories(id) ON DELETE CASCADE,
  epic_id INTEGER REFERENCES epics(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX notifications_user ON notifications(user_id, id);

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  project_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE review_types (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  review_type_id INTEGER NOT NULL REFERENCES review_types(id) ON DELETE CASCADE,
  reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'unstarted' CHECK (status IN ('unstarted','in_review','pass','revise')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX reviews_story ON reviews(story_id);
`,
];
