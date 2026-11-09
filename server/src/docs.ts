export const API_DESCRIPTION = `
REST API for Tracker, a self-hosted agile project tracker. Everything the web app does goes through this API.

## Authentication

Every user has an **API token** (Profile → API token, or \`GET /api/v1/me\`). Send it on each request:

\`\`\`
curl -H "X-TrackerToken: $TOKEN" https://tracker.example.com/api/v1/projects
\`\`\`

\`Authorization: Bearer <token>\` also works. Browsers use a session cookie set by \`POST /auth/login\`.

## Conventions

* JSON in, JSON out. Timestamps are ISO-8601 UTC; calendar dates are \`YYYY-MM-DD\`.
* Every resource has a \`kind\` field (\`story\`, \`project\`, …).
* \`PUT\` performs partial updates: omitted fields are unchanged. List-valued fields (\`owner_ids\`, \`label_ids\`, …) replace the whole list.
* Unknown body fields are ignored.

## Pagination

List endpoints accept \`limit\` and \`offset\` and return these headers:
\`X-Tracker-Pagination-Total\`, \`X-Tracker-Pagination-Limit\`, \`X-Tracker-Pagination-Offset\`, \`X-Tracker-Pagination-Returned\`.

## Errors

Errors use a consistent envelope with an HTTP 4xx/5xx status:

\`\`\`json
{ "kind": "error", "code": "invalid_parameter", "error": "Unestimated feature stories cannot be started.",
  "possible_fix": "Give the story an estimate first." }
\`\`\`

Codes: \`invalid_parameter\` (400), \`unauthenticated\` (401), \`unauthorized_operation\` (403), \`unfound_resource\` (404),
\`conflict\` (409), \`request_too_large\` (413), \`too_many_requests\` (429), \`server_error\` (500).

## Story workflow

\`\`\`
unscheduled (icebox) → unstarted → started → finished → delivered → accepted
                                                              ↘ rejected → started …
\`\`\`
Chores go \`started → accepted\`. Releases go \`unstarted → accepted\`. Features need an estimate before they can be started.

## Planning

Stories share one priority order per project (\`position\`). Reorder with \`before_id\`/\`after_id\` on \`PUT /stories/:id\`.
Velocity is the average points accepted over the last \`velocity_averaged_over\` iterations (normalised for team strength and
iteration length). The current iteration and backlog are filled by velocity in priority order (see \`GET /iterations\`).

## Realtime & webhooks

\`GET /api/v1/events\` streams Server-Sent Events for the projects you subscribe to. Project webhooks POST every activity
as JSON, signed with \`X-Tracker-Signature: sha256=HMAC_SHA256(secret, body)\`.

## Version control

Reference stories in commit messages — \`[#123]\`, \`[Finishes #123]\`, \`[Delivers #123]\` — and send commits via
\`POST /source_commits\` or a repository push webhook to \`/integrations/vcs?token=…\`.
`;

export const TAGS = [
  { name: 'Account', description: 'Sign-up, sign-in, profile and API token' },
  { name: 'Projects', description: 'Projects and their settings' },
  { name: 'Members', description: 'Project memberships and invitations' },
  { name: 'Stories', description: 'Stories: create, update, prioritise, change state, move' },
  { name: 'Tasks', description: 'Checklist items on a story' },
  { name: 'Comments', description: 'Comments on stories and epics' },
  { name: 'Attachments', description: 'File uploads attached to comments' },
  { name: 'Blockers', description: 'Things blocking a story' },
  { name: 'Reviews', description: 'Code/design/QA reviews on stories' },
  { name: 'Labels', description: 'Labels for grouping stories' },
  { name: 'Epics', description: 'Large features grouping stories via a label' },
  { name: 'Iterations', description: 'Velocity-driven iteration planning' },
  { name: 'Search', description: 'Story search query language' },
  { name: 'Activity', description: 'Project and story history' },
  { name: 'Analytics', description: 'Velocity, burn-up, cycle time' },
  { name: 'My work', description: 'Cross-project view of your work' },
  { name: 'Notifications', description: 'In-app (and email) notifications' },
  { name: 'Workspaces', description: 'Multi-project views' },
  { name: 'Webhooks', description: 'Outgoing activity webhooks' },
  { name: 'Integrations', description: 'Source control commit linking' },
  { name: 'Import & export', description: 'CSV import and export' },
  { name: 'Realtime', description: 'Server-Sent Events stream' },
  { name: 'Administration', description: 'Instance administration (admins only)' },
];
