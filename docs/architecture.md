# Architecture and extension points

```
web/ (React SPA) ──HTTP/JSON + SSE──▶ server/ (Fastify)
                                        routes/      HTTP endpoints. TypeBox schemas drive validation, serialization and OpenAPI
                                        services/    domain logic: stories, search, activity, projects, webhooks, vcs
                                        lib/         pure logic: workflow, iteration planning, dates, csv, net
                                        db/          node:sqlite wrapper + append-only migrations
```

## Request lifecycle

1. **Authentication** (`app.ts`, `onRequest`). The API token is read from a header (or `?token=` on the few routes that allow it). Otherwise the session cookie is used. Cookie-authenticated requests that change data must pass the same-origin (CSRF) check.
2. **Validation** happens against the route's TypeBox schema. Unknown body fields are removed (`removeAdditional: 'all'`).
3. **Authorization** happens in each handler with `access(ctx, projectId, user, 'viewer' | 'member' | 'owner')`. It returns 404 rather than 403 for private projects, so their existence isn't revealed.
4. **Mutation** runs inside `ctx.tx()`. Activity, notifications and email are recorded in the same transaction. Side effects are queued with `ctx.afterCommit()`, so nothing is announced for work that is rolled back.
5. **Serialization** uses the route's response schema. Fields that aren't documented are never sent.

## Extension points

### Activity sinks — react to anything that happens

Every change produces an *activity*: the same JSON that webhooks receive. Built-in sinks deliver activities to the live-update stream and to webhooks. To add an integration such as chat notifications, an audit log or a search index, register another sink:

```ts
app.ctx.onActivity('slack', (projectId, activity) => {
  if (activity.kind === 'story_update_activity') void postToSlack(projectId, activity.message);
});
```

Sinks run after commit and are isolated from each other: a sink that throws is logged and doesn't affect the request or the other sinks. Do slow work asynchronously.

### Story workflow — `server/src/lib/workflow.ts`

Story types, their allowed states, estimation rules, the buttons offered at each state, and activity verbs are all declared in one table. Validation, iteration planning and the commit integration derive their rules from it.

The web UI has its own copy, in `web/src/util.ts`, so it can respond instantly. `test/workflow.test.ts` fails if the two disagree. Adding a state or story type means changing this table, the database `CHECK` constraint (in a new migration), and the web copy.

### Search filters — `server/src/services/search.ts`

Each `key:value` filter is an entry in a registry, mapping its values to a predicate on a story:

```ts
registerSearchFilter('points_over', (values) => (story) => (story.estimate ?? 0) > Number(values[0]));
// now:  GET /projects/1/search?query=points_over:3 -label:wontfix
```

Parsing, negation (`-key:`), comma-separated alternatives, and the "me" / person lookup (via `SearchContext.personIds`) are handled for you.

### Source-control providers — `server/src/services/vcs.ts`

A push webhook is handled by the first adapter whose `detect(headers, body)` matches. The adapter returns the pushed commits in a common shape:

```ts
registerVcsAdapter({
  name: 'sourcehut',
  detect: (headers) => !!headers['x-sourcehut-event'],
  commits: (body) => body.commits.map((c) => ({ id: c.id, message: c.message, url: c.url, author: c.author?.name })),
});
```

Commit message parsing (`[Finishes #123]`) and the story state changes it triggers are shared by all providers.

### Iteration planning — `server/src/lib/iterations.ts`

`computePlan(project, stories, overrides, { today, velocity })` is a pure function, so it is easy to test and reuse; analytics, for example, calls it too. Its invariants are pinned by `test/planning.property.test.ts`.

### Database migrations — `server/src/db/migrations.ts`

Migrations are append-only SQL strings. Each one runs once, inside a transaction, tracked by `PRAGMA user_version`. Never edit a migration that has been released; add a new one instead.

`Database.insert` and `Database.update` only accept plain identifiers for table and column names, which guards against SQL injection through object keys.

## Testing strategy

| Layer | Test |
|---|---|
| Pure logic | Example tests plus property-based tests (seeded, reproducible) |
| API contract | Snapshot of the generated OpenAPI document |
| Authorization | A matrix generated from the OpenAPI document, so new routes are covered automatically |
| Security | Targeted regression tests per vulnerability class |
| Behaviour | API integration tests through `app.inject` against an in-memory database |
| UI | Playwright smoke test against the production build |

When a refactoring changes the API on purpose, run `npm run openapi` and review the diff to `docs/openapi.json`. That diff is the change in the public contract.
