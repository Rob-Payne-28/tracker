/**
 * Source-control push webhook adapters. Each adapter recognises one provider's request and extracts
 * its commits in a common shape. Add a provider with registerVcsAdapter(); the first adapter whose
 * detect() matches handles the request.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { badRequest } from '../lib/errors.js';

export interface PushedCommit {
  id?: string;
  message: string;
  url?: string;
  author?: string;
}

export interface VcsAdapter {
  name: string;
  detect(headers: IncomingHttpHeaders, body: any): boolean;
  /** Commits in the push, oldest first. Return [] for non-push events (pings etc.). */
  commits(body: any, headers: IncomingHttpHeaders): PushedCommit[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** GitHub, GitLab and Gitea share the `commits: [{ id, message, url, author: { name } }]` shape. */
const commitsArray = (body: any): PushedCommit[] => {
  if (!Array.isArray(body?.commits)) return [];
  return body.commits
    .filter((c: any) => typeof c?.message === 'string')
    .map((c: any) => ({ id: str(c.id), message: c.message, url: str(c.url), author: str(c.author?.name) }));
};

const ADAPTERS: VcsAdapter[] = [
  { name: 'github', detect: (h) => !!h['x-github-event'], commits: (b, h) => (h['x-github-event'] === 'push' ? commitsArray(b) : []) },
  { name: 'gitlab', detect: (h) => !!h['x-gitlab-event'], commits: commitsArray },
  { name: 'gitea', detect: (h) => !!h['x-gitea-event'] || !!h['x-forgejo-event'], commits: commitsArray },
  {
    name: 'bitbucket',
    detect: (h) => !!h['x-event-key'] && String(h['x-event-key']).startsWith('repo:'),
    commits: (b) => {
      const changes = Array.isArray(b?.push?.changes) ? b.push.changes : [];
      return changes
        .flatMap((ch: any) => (Array.isArray(ch?.commits) ? [...ch.commits].reverse() : []))
        .filter((c: any) => typeof c?.message === 'string')
        .map((c: any) => ({ id: str(c.hash), message: c.message, url: str(c.links?.html?.href), author: str(c.author?.user?.display_name) ?? str(c.author?.raw) }));
    },
  },
  // Fallback: any JSON body with a GitHub-style commits array.
  { name: 'other', detect: (_h, b) => Array.isArray(b?.commits), commits: commitsArray },
];

export function registerVcsAdapter(adapter: VcsAdapter, opts: { before?: string } = {}) {
  const at = opts.before ? ADAPTERS.findIndex((a) => a.name === opts.before) : ADAPTERS.length - 1; // default: before the fallback
  ADAPTERS.splice(at < 0 ? ADAPTERS.length : at, 0, adapter);
}

export function parsePush(headers: IncomingHttpHeaders, body: unknown): { provider: string; commits: PushedCommit[] } {
  if (!body || typeof body !== 'object') throw badRequest('Expected a JSON push payload.');
  const adapter = ADAPTERS.find((a) => a.detect(headers, body));
  if (!adapter) throw badRequest('Unrecognised push payload.', 'Send a GitHub, GitLab, Gitea or Bitbucket push webhook, or POST /source_commits.');
  return { provider: adapter.name, commits: adapter.commits(body, headers) };
}
