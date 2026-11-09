/**
 * Outgoing webhooks: every committed activity is POSTed as JSON to the project's enabled webhooks,
 * signed with HMAC-SHA256. Delivery refuses non-public addresses (unless WEBHOOK_ALLOW_PRIVATE) at
 * connect time, never follows redirects, and times out after 10 seconds.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Ctx } from './context.js';
import type { Row } from '../db/index.js';
import { now } from '../db/index.js';
import { guardedLookup, isPrivateAddress } from '../lib/net.js';

export const WEBHOOK_TIMEOUT_MS = 10_000;

export function signPayload(secret: string, body: string) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export interface DeliveryResult {
  status: number | null;
  error: string | null;
}

/** POST a JSON body to a URL with SSRF protections. Resolves with the HTTP status or an error. */
export function postJson(rawUrl: string, body: string, headers: Record<string, string>, allowPrivate: boolean): Promise<DeliveryResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return resolve({ status: null, error: 'Invalid URL' });
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // IP literals bypass `lookup`, so check them directly.
    if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) {
      return resolve({ status: null, error: 'Refusing to deliver to a non-public address' });
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...headers },
        lookup: guardedLookup(allowPrivate),
        timeout: WEBHOOK_TIMEOUT_MS,
      },
      (res) => {
        res.resume(); // discard body; redirects are deliberately not followed
        const status = res.statusCode ?? null;
        resolve({ status, error: status && status >= 200 && status < 300 ? null : `HTTP ${status}` });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', (e: any) => resolve({ status: null, error: e.code === 'EBLOCKED' ? e.message : String(e.message ?? e) }));
    req.end(body);
  });
}

export async function deliverOne(ctx: Ctx, hook: Row, payload: unknown): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const result = await postJson(
    hook.url,
    body,
    {
      'User-Agent': 'Tracker-Webhooks/1.0',
      'X-Tracker-Signature': signPayload(hook.secret, body),
      'X-Tracker-Webhook-Id': String(hook.id),
    },
    ctx.config.webhookAllowPrivate,
  );
  try {
    ctx.db.run('UPDATE webhooks SET last_status = ?, last_error = ?, last_delivered_at = ? WHERE id = ?', [result.status, result.error, now(), hook.id]);
  } catch {
    /* database closed during shutdown */
  }
  return result;
}

/** Activity sink that delivers to all enabled webhooks of the project. */
export function webhookSink(ctx: Ctx) {
  return (projectId: number, activity: unknown) => {
    let hooks: Row[];
    try {
      hooks = ctx.db.all('SELECT * FROM webhooks WHERE project_id = ? AND enabled = 1', [projectId]);
    } catch {
      return;
    }
    for (const hook of hooks) void deliverOne(ctx, hook, activity);
  };
}
