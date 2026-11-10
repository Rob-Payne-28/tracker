# Tracker API guide

This guide explains how the API fits together and walks through common tasks. For every endpoint, parameter and schema, see:

- **Interactive reference**: `https://<your-tracker>/api/docs`
- **OpenAPI 3.1 document**: `https://<your-tracker>/api/openapi.json` (a copy is kept at [`openapi.json`](openapi.json))

The OpenAPI document is generated from the same schemas the server uses to validate requests and serialize responses, so it always matches how the server actually behaves.

Base path: `/api/v1`.

---

## Authentication

Find your API token under **Profile → API token**, or in `GET /api/v1/me`. Send it with every request:

```sh
export TRACKER=https://tracker.example.com
export TOKEN=...   # your API token

curl -H "X-TrackerToken: $TOKEN" $TRACKER/api/v1/me
```

`Authorization: Bearer $TOKEN` also works. Browsers authenticate with a session cookie from `POST /auth/login`.

Requests that change data using the session cookie must send an `Origin` (or `Referer`) header matching the server. Browsers do this automatically; otherwise the request is rejected with `403 csrf_rejected`. Token-authenticated requests are not subject to this check.

`?token=` is accepted **only** on two endpoints: `GET /events` (because a browser `EventSource` can't set headers) and `GET /attachments/{id}/download`.

Regenerate a token with `POST /me/regenerate_api_token`.

## Conventions

| | |
|---|---|
| Format | JSON request and response bodies (`Content-Type: application/json`) |
| Times | ISO-8601 UTC timestamps; calendar dates use `YYYY-MM-DD` |
| `kind` | Every resource names its type: `"kind": "story"` |
| Updates | `PUT` is a partial update. Fields you leave out don't change. List fields such as `owner_ids`, `label_ids`, `labels` and `follower_ids` **replace** the whole list |
| Unknown fields | Ignored |
| Pagination | `limit` and `offset` query parameters; response headers `X-Tracker-Pagination-Total`, `-Limit`, `-Offset`, `-Returned` |

### Errors

```json
HTTP/1.1 400 Bad Request
{
  "kind": "error",
  "code": "invalid_parameter",
  "error": "Unestimated feature stories cannot be started.",
  "general_problem": "Unestimated feature stories cannot be started.",
  "possible_fix": "Give the story an estimate first."
}
```

Validation failures also include `validation_errors: [{ field, problem }]`.

| HTTP status | `code` |
|---|---|
| 400 | `invalid_parameter` |
| 401 | `unauthenticated` |
| 403 | `unauthorized_operation`, `csrf_rejected` |
| 404 | `unfound_resource`, `route_not_found` |
| 409 | `conflict` |
| 413 | `request_too_large` |
| 429 | `too_many_requests` |
| 500 | `server_error` |

The API returns 404, not 403, for private projects you aren't a member of, so it doesn't reveal that they exist.

---

## Core concepts

### Projects and roles

| Role | Can |
|---|---|
| `viewer` | Read everything |
| `member` | Create, edit, prioritise and delete stories, epics and labels |
| `owner` | Everything above, plus project settings, memberships, webhooks and review types |

Anyone can read a **public** project, even without signing in. Instance administrators act as owners in every project.

### Stories

```json
{
  "kind": "story", "id": 42, "project_id": 1,
  "name": "Checkout with Apple Pay", "description": "Markdown…",
  "story_type": "feature", "current_state": "started", "estimate": 5,
  "requested_by_id": 1, "owner_ids": [2], "follower_ids": [1, 2],
  "labels": [{ "kind": "label", "id": 3, "name": "payments" }], "label_ids": [3],
  "tasks_total": 3, "tasks_completed": 1, "comment_count": 1,
  "blocker_count": 1, "blocked_by_story_ids": [], "blocking_story_ids": [],
  "deadline": null, "accepted_at": null, "started_at": "2026-11-09T10:00:00Z",
  "planned_iteration_number": null, "position": 5120, "url": "https://…/projects/1/stories/42", …
}
```

`GET /projects/{id}/stories/{story_id}` also returns `tasks`, `comments` (with `file_attachments`), `blockers` and `reviews`.

#### Workflow

```
unscheduled ─▶ unstarted ─▶ started ─▶ finished ─▶ delivered ─▶ accepted
 (icebox)                      ▲                        │
                               └──── rejected ◀─────────┘
```

| Type | Allowed states | Estimable |
|---|---|---|
| `feature` | all | yes; **must** be estimated before it can be started |
| `bug` | all | only if the project's `bugs_and_chores_are_estimatable` is true |
| `chore` | unscheduled, unstarted, started, accepted | same as bug |
| `release` | unscheduled, unstarted, accepted | never; may have a `deadline` |

Side effects of state changes:

- Starting a story that has no owners makes you the owner.
- Accepting a story sets `accepted_at`. You can pass `accepted_at` to backdate it, which is useful for imports.
- Moving a story out of `accepted` clears `accepted_at`.
- Changing `story_type` adjusts the state and estimate when they aren't valid for the new type.

#### Prioritisation

All stories in a project share one priority order. Move a story by naming its new neighbour:

```sh
# Put story 42 directly above story 17
curl -X PUT -H "X-TrackerToken: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"before_id": 17}' $TRACKER/api/v1/projects/1/stories/42

# Move it from the icebox into the backlog, right after story 30
curl -X PUT … -d '{"current_state": "unstarted", "after_id": 30}' …/stories/42
```

In the backlog, in-progress stories always sort above unstarted ones, and accepted stories sort above both.

### Iterations and velocity

Iterations are **computed, not stored**. Each iteration is `iteration_length` weeks long. The first one starts on the project's `start_date`, aligned back to `week_start_day`.

- **Velocity** is the average of the points accepted in the last `velocity_averaged_over` completed iterations. Each iteration's points are normalised by its team strength and length. Before any iteration has completed, velocity is `initial_velocity`.
- **Current iteration** is the iteration containing today. It holds stories accepted during it, every in-progress story, and then unstarted stories in priority order while they fit within *velocity × team strength × length factor*.
- **Backlog iterations** continue the same filling. A story that doesn't fit closes the iteration; later, smaller stories don't jump ahead of it. An empty iteration accepts a story of any size.
- **Done iterations** group accepted stories by the date they were accepted, in the project's time zone.
- **Points**: features count their estimate. Bugs and chores count only if they're estimable. Releases count zero.

```sh
GET /projects/1/iterations?scope=current_backlog       # current + projected backlog, with stories
GET /projects/1/iterations?scope=done&limit=5          # last 5 completed iterations, newest first
GET /projects/1/iterations?velocity=20                 # "what if" projection
GET /projects/1/board                                   # everything the planning board needs in one call
PUT /projects/1/iteration_overrides/12  {"team_strength": 0.5}   # holiday week
PUT /projects/1/iteration_overrides/13  {"length": 2}            # longer iteration, shifts later dates
```

With `automatic_planning: false`, backlog stories are placed by their `planned_iteration_number`. Stories without one are listed in `unplanned_ids`.

The `/board` response includes `releases[]`, each with a `projected_completion` date and a `behind_schedule` flag based on the release's `deadline`.

---

## Recipes

### Create a story

```sh
curl -X POST -H "X-TrackerToken: $TOKEN" -H 'Content-Type: application/json' $TRACKER/api/v1/projects/1/stories -d '{
  "name": "Export invoices as PDF",
  "story_type": "feature",
  "estimate": 3,
  "current_state": "unstarted",
  "labels": ["billing", "export"],
  "description": "As an accountant I can download invoices as PDF.",
  "tasks": [{"description": "Pick a PDF library"}, {"description": "Template"}]
}'
```

Labels given by name are created if they don't exist. Without `before_id` or `after_id`, icebox stories go to the top of the icebox and other stories go to the bottom of the backlog.

### Move a story through the workflow

```sh
for s in started finished delivered accepted; do
  curl -s -X PUT -H "X-TrackerToken: $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"current_state\":\"$s\"}" $TRACKER/api/v1/projects/1/stories/42 > /dev/null
done
```

### Comment with an attachment

```sh
FILE_ID=$(curl -s -H "X-TrackerToken: $TOKEN" -F file=@screenshot.png \
  $TRACKER/api/v1/projects/1/uploads | jq .id)

curl -X POST -H "X-TrackerToken: $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"text\": \"Looks off on mobile @sam\", \"file_attachment_ids\": [$FILE_ID]}" \
  $TRACKER/api/v1/projects/1/stories/42/comments
```

`@username` notifies that project member. Commenting on a story makes you a follower of it.

### Bulk updates

```sh
PUT /projects/1/stories/bulk
{ "story_ids": [4, 5, 6], "add_labels": ["q3"], "move": "top_of_backlog" }

POST /projects/1/stories/bulk_delete
{ "story_ids": [7, 8] }
```

A bulk request is atomic: if any story fails validation, none of them change.

### Sync changes incrementally

Every change increments the project's `version`. Each activity entry records the version it produced.

```sh
GET /projects/1/activity?since_version=1234
```

---

## Search query language

`GET /projects/{id}/search?query=…` returns `{ stories, epics, total_hits, total_points, total_points_completed }`. The same syntax works in `GET /projects/{id}/stories?filter=…`.

| Syntax | Meaning |
|---|---|
| `login page` | Every word must appear in the name, description, comments, tasks or labels |
| `"exact phrase"` | A phrase match |
| `label:ui` / `label:"needs design"` | Has the label. Separate alternatives with commas: `label:ui,api` |
| `type:bug` | `feature`, `bug`, `chore` or `release` |
| `state:started` | Any state. `state:done` means accepted |
| `owner:me` / `owner:jd` | Owner, matched by `me`, username, initials, name or email |
| `requester:`, `follower:`, `reviewer:` | The same, for those relationships |
| `mywork:me` | Owned by me and not yet accepted |
| `id:12,15` | Specific stories |
| `estimate:3` / `estimate:none` | By estimate |
| `epic:"Onboarding"` | Stories carrying the epic's label |
| `is:blocked`, `is:blocking`, `is:unestimated`, `is:estimated` | |
| `has:attachment`, `has:comment`, `has:task`, `has:blocker`, `has:description`, `has:label`, `has:owner`, `has:review`, `has:deadline` | |
| `name:foo`, `description:bar` | Text in a single field |
| `created_since:2026-01-01`, `created_before:`, `updated_since:`, `updated_before:`, `accepted_since:`, `accepted_before:` | Date filters |
| `includedone:true` | Include accepted stories, which are excluded by default |
| `-label:wontfix`, `-flaky` | Put `-` in front of any filter or word to negate it |

---

## Realtime events (Server-Sent Events)

```js
const es = new EventSource(`/api/v1/events?project_ids=1,2&token=${TOKEN}`);
es.addEventListener('activity', (e) => console.log(JSON.parse(e.data).message));
es.addEventListener('notification', (e) => console.log('for me:', JSON.parse(e.data)));
```

| Event | Data |
|---|---|
| `activity` | An Activity resource. Something changed in a subscribed project |
| `notification` | A Notification for the authenticated user |
| `project` | Project-level events such as `{ "deleted": true }` |
| `ping` | Keep-alive, sent every 25 seconds |

---

## Webhooks

Project owners register URLs with `POST /projects/{id}/webhooks {"url": "…"}`. Tracker POSTs **every activity** in the project to each registered URL:

```json
{
  "kind": "story_update_activity",
  "guid": "1_57",
  "project_version": 57,
  "message": "Sam Rivera started \"Checkout with Apple Pay\"",
  "highlight": "started",
  "changes": [{
    "kind": "story", "change_type": "update", "id": 42, "name": "Checkout with Apple Pay", "story_type": "feature",
    "original_values": { "current_state": "unstarted", "owner_ids": [] },
    "new_values":      { "current_state": "started",   "owner_ids": [2] }
  }],
  "primary_resources": [{ "kind": "story", "id": 42, "name": "Checkout with Apple Pay", "story_type": "feature", "url": "…" }],
  "project": { "kind": "project", "id": 1, "name": "Orbit" },
  "performed_by": { "kind": "person", "id": 2, "name": "Sam Rivera", "initials": "SR", "username": "samrivera", "email": "…" },
  "occurred_at": "2026-11-09T14:31:02.120Z"
}
```

Each delivery carries these headers:

- `X-Tracker-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the webhook secret>`
- `X-Tracker-Webhook-Id`

Deliveries time out after 10 seconds and never follow redirects. Webhook URLs must be publicly reachable unless the administrator sets `WEBHOOK_ALLOW_PRIVATE=true`. The status of the last delivery is recorded on the webhook (`last_status`, `last_error`). `POST /webhooks/{id}/test` sends a `ping` payload.

Verify the signature in Node:

```js
import crypto from 'node:crypto';
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-tracker-signature']));
```

…or in Python:

```python
import hmac, hashlib
expected = 'sha256=' + hmac.new(SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
ok = hmac.compare_digest(expected, request.headers['X-Tracker-Signature'])
```

Common activity kinds:

- `story_create_activity`, `story_update_activity`, `story_delete_activity`
- `story_move_into_project_activity`, `story_move_from_project_activity`
- `comment_create_activity`, `comment_update_activity`, `comment_delete_activity`
- `task_*_activity`, `blocker_*_activity`, `review_*_activity`
- `epic_*_activity`, `label_*_activity`
- `project_update_activity`, `project_membership_*_activity`
- `iteration_update_activity`, `story_import_activity`

---

## Source control integration

Reference stories in commit messages:

| In the commit message | Effect |
|---|---|
| `[#123]` | Comments on story 123 with the commit message and URL |
| `[Finishes #123]`, `[Fixes #123]`, `[Completes #123]` | Comments, then moves the story to **finished**. Chores move to **accepted** |
| `[Delivers #123 #124]` | Comments, then moves the stories to **delivered** |

Stories never move backwards.

You can send commits in two ways.

**Option 1: a repository push webhook.** This works with GitHub, GitLab, Gitea/Forgejo and Bitbucket. Tracker detects the provider from its event header. Any other JSON body with a GitHub-style `commits` array is also accepted. Use content type `application/json` and this URL:

```
https://tracker.example.com/api/v1/integrations/vcs?token=<API token>
```

**Option 2: post commits yourself**, for example from CI:

```sh
curl -X POST -H "X-TrackerToken: $TOKEN" -H 'Content-Type: application/json' $TRACKER/api/v1/source_commits -d '{
  "source_commit": { "message": "Add PDF export [Finishes #42]", "author": "Dana", "commit_id": "a1b2c3d", "url": "https://git.example.com/…/a1b2c3d" }
}'
```

---

## CSV import and export

- `GET /projects/{id}/export.csv` exports stories. Use `include_done=false` or `include_icebox=false` to leave those out.
- `POST /projects/{id}/import` imports stories. Send the CSV either as `Content-Type: text/csv` or as `{"csv": "…"}`.

The file needs a **Title** column. These columns are optional:

- Type
- Estimate
- Current State
- Labels (comma separated)
- Description
- Requested By
- Owned By (repeatable)
- Deadline
- Created at
- Accepted at
- Comment (repeatable)
- Task and Task Status (repeatable pairs)

People are matched against project members by name, username or email. Rows that fail are reported in `errors[]`; the remaining rows still import.
