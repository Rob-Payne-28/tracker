import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { requireUser } from '../app.js';
import { access } from '../services/projects.js';
import { getStoryRow, updateStory } from '../services/stories.js';
import { createComment } from './story_parts.js';
import type { Ctx } from '../services/context.js';
import type { User } from '../services/people.js';

export interface CommitInput {
  message: string;
  author?: string;
  commit_id?: string;
  url?: string;
  commit_type?: string;
}

/**
 * Parse story references from a commit message.
 *   [#123]                 comment only
 *   [Finishes #123]        finish (Fixes / Completes / Finished / Fixed / Completed are synonyms)
 *   [Delivers #123 #456]   deliver
 */
export function parseCommitMessage(message: string): { story_id: number; action: 'finish' | 'deliver' | null }[] {
  const out = new Map<number, 'finish' | 'deliver' | null>();
  for (const block of message.matchAll(/\[([^\]]*#\d+[^\]]*)\]/g)) {
    const inner = block[1];
    const verb = inner.match(/^\s*(finish(?:es|ed)?|fix(?:es|ed)?|complete[sd]?|deliver(?:s|ed)?)\b/i)?.[1]?.toLowerCase();
    const action = !verb ? null : verb.startsWith('deliver') ? 'deliver' : 'finish';
    for (const ref of inner.matchAll(/#(\d+)/g)) {
      const id = Number(ref[1]);
      const prev = out.get(id);
      out.set(id, prev === 'deliver' || action === 'deliver' ? 'deliver' : (action ?? prev ?? null));
    }
  }
  return [...out].map(([story_id, action]) => ({ story_id, action }));
}

export function processCommit(ctx: Ctx, user: User, commit: CommitInput) {
  const results: { story_id: number; ok: boolean; action: string | null; error?: string }[] = [];
  for (const { story_id, action } of parseCommitMessage(commit.message)) {
    try {
      const story = getStoryRow(ctx, story_id);
      const a = access(ctx, story.project_id, user, 'member');
      const header = `Commit${commit.author ? ` by ${commit.author}` : ''}${commit.commit_id ? ` \`${commit.commit_id.slice(0, 10)}\`` : ''}`;
      createComment(ctx, a, user, { story }, {
        text: `${header}\n\n${commit.message}${commit.url ? `\n\n${commit.url}` : ''}`,
        commit_identifier: commit.commit_id ?? null,
        commit_type: commit.commit_type ?? 'other',
      });
      if (action) {
        let target: any = action === 'deliver' ? 'delivered' : 'finished';
        if (story.story_type === 'chore') target = 'accepted';
        if (story.story_type === 'release') target = null;
        const order = ['unscheduled', 'unstarted', 'started', 'rejected', 'finished', 'delivered', 'accepted'];
        if (target && order.indexOf(target) > order.indexOf(story.current_state)) {
          updateStory(ctx, a, user, story.id, { current_state: target });
        }
      }
      results.push({ story_id, ok: true, action });
    } catch (e: any) {
      results.push({ story_id, ok: false, action, error: e.message ?? String(e) });
    }
  }
  return results;
}

const Result = Type.Array(
  Type.Object({ story_id: Type.Integer(), ok: Type.Boolean(), action: Type.Union([Type.String(), Type.Null()]), error: Type.Optional(Type.String()) }),
);

export async function integrationRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.post(
    '/source_commits',
    {
      schema: {
        tags: ['Integrations'],
        summary: 'Post a source commit',
        description:
          'Link a commit to stories. Reference stories in the message in square brackets: `[#123]` comments on the story, `[Finishes #123]` (or Fixes/Completes) also finishes it, `[Delivers #123]` delivers it. Several ids may share a bracket. Chores are accepted instead of finished. Stories are never moved backwards.',
        body: Type.Object({
          source_commit: Type.Object({
            message: Type.String(),
            author: Type.Optional(Type.String()),
            commit_id: Type.Optional(Type.String()),
            url: Type.Optional(Type.String()),
          }),
        }),
        response: { 200: Result },
      },
    },
    async (req) => {
      const u = requireUser(req);
      return processCommit(ctx, u, (req.body as any).source_commit);
    },
  );

  app.post(
    '/integrations/vcs',
    {
      config: { allowQueryToken: true },
      schema: {
        tags: ['Integrations'],
        summary: 'GitHub / GitLab / Gitea push webhook',
        description:
          'Point a repository push webhook (content type application/json) at `/api/v1/integrations/vcs?token=<your API token>`. Each pushed commit is processed like POST /source_commits. Commits are attributed to the token owner, with the commit author shown in the comment.',
        querystring: Type.Object({ token: Type.Optional(Type.String()) }),
        body: Type.Object(
          {
            commits: Type.Optional(
              Type.Array(
                Type.Object(
                  {
                    id: Type.Optional(Type.String()),
                    message: Type.String(),
                    url: Type.Optional(Type.String()),
                    author: Type.Optional(Type.Object({ name: Type.Optional(Type.String()) }, { additionalProperties: true })),
                  },
                  { additionalProperties: true },
                ),
              ),
            ),
          },
          { additionalProperties: true },
        ),
        response: { 200: Type.Object({ processed: Type.Integer(), results: Result }) },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const body = req.body as any;
      const kind = req.headers['x-github-event'] ? 'github' : req.headers['x-gitlab-event'] ? 'gitlab' : req.headers['x-gitea-event'] ? 'gitea' : 'other';
      const results = [];
      for (const c of body.commits ?? []) {
        results.push(...processCommit(ctx, u, { message: c.message, commit_id: c.id, url: c.url, author: c.author?.name, commit_type: kind }));
      }
      return { processed: (body.commits ?? []).length, results };
    },
  );
}
