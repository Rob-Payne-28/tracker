import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from './config.js';
import { Ctx } from './services/context.js';
import type { User } from './services/people.js';
import { ApiError, unauthenticated } from './lib/errors.js';
import { sha256 } from './lib/auth.js';
import { allSchemas } from './schemas.js';
import { API_DESCRIPTION, TAGS } from './docs.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { storyRoutes } from './routes/stories.js';
import { storyPartsRoutes } from './routes/story_parts.js';
import { planningRoutes } from './routes/planning.js';
import { personalRoutes } from './routes/personal.js';
import { attachmentRoutes } from './routes/attachments.js';
import { adminRoutes } from './routes/admin.js';
import { integrationRoutes } from './routes/integrations.js';
import { startMaintenance } from './services/maintenance.js';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: Ctx;
  }
  interface FastifyRequest {
    user: User | null;
  }
  interface FastifyContextConfig {
    /** Allow ?token= authentication (for EventSource and download links). */
    allowQueryToken?: boolean;
  }
}

export const SESSION_COOKIE = 'tracker_session';
export const VERSION = '1.0.0';

export async function buildApp(overrides: Partial<Config> = {}): Promise<FastifyInstance> {
  const config = loadConfig(overrides);
  const ctx = new Ctx(config);

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: true, coerceTypes: 'array', useDefaults: true, allErrors: false } },
  });
  app.decorate('ctx', ctx);
  app.decorateRequest('user', null);
  app.addHook('onClose', async () => ctx.close());

  for (const s of allSchemas) app.addSchema(s);

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 10 } });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Tracker API', version: VERSION, description: API_DESCRIPTION },
      servers: [{ url: config.baseUrl, description: 'This server' }],
      tags: TAGS,
      components: {
        securitySchemes: {
          ApiToken: { type: 'apiKey', in: 'header', name: 'X-TrackerToken', description: 'Your API token (Profile → API token).' },
          BearerToken: { type: 'http', scheme: 'bearer', description: 'Your API token as a bearer token.' },
          Session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE, description: 'Browser session cookie.' },
        },
      },
      security: [{ ApiToken: [] }, { BearerToken: [] }, { Session: [] }],
    },
    refResolver: { buildLocalReference: (json, _base, _frag, i) => (json.$id as string) || `def-${i}` },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs', uiConfig: { docExpansion: 'list', deepLinking: true } });
  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // Every API route documents the shared error envelope.
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/v1')) return;
    route.schema ??= {};
    const response = ((route.schema as any).response ??= {});
    response['4XX'] ??= { $ref: 'Error#', description: 'Error' };
  });

  // ---- Authentication
  app.addHook('onRequest', async (req) => {
    req.user = authenticate(ctx, req);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({
        kind: 'error',
        code: err.code,
        error: err.message,
        general_problem: err.message,
        ...(err.possibleFix ? { possible_fix: err.possibleFix } : {}),
      });
    }
    if (err.validation) {
      return reply.status(400).send({
        kind: 'error',
        code: 'invalid_parameter',
        error: err.message,
        general_problem: 'One or more request parameters was invalid.',
        validation_errors: err.validation.map((v: any) => ({
          field: (v.instancePath || '').replace(/^\//, '').replace(/\//g, '.') || v.params?.missingProperty || v.params?.additionalProperty || '',
          problem: v.message ?? 'invalid',
        })),
      });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({
      kind: 'error',
      code: status === 413 ? 'request_too_large' : status >= 500 ? 'server_error' : 'bad_request',
      error: status >= 500 ? 'An unexpected error occurred.' : err.message,
    });
  });

  // ---- API routes
  await app.register(
    async (api) => {
      await authRoutes(api);
      await projectRoutes(api);
      await storyRoutes(api);
      await storyPartsRoutes(api);
      await planningRoutes(api);
      await personalRoutes(api);
      await attachmentRoutes(api);
      await adminRoutes(api);
      await integrationRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  app.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true, version: VERSION }));

  // ---- Web UI (single page app)
  const webDist = config.webDist && fs.existsSync(path.join(config.webDist, 'index.html')) ? config.webDist : null;
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false, maxAge: '1h' });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !webDist || req.method !== 'GET') {
      return reply.status(404).send({ kind: 'error', code: 'route_not_found', error: `No route for ${req.method} ${req.url.split('?')[0]}` });
    }
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });

  startMaintenance(app);
  return app;
}

function authenticate(ctx: Ctx, req: FastifyRequest): User | null {
  const header = (req.headers['x-trackertoken'] as string | undefined) ?? undefined;
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  let token = header ?? bearer;
  if (!token && req.routeOptions.config?.allowQueryToken) token = (req.query as any)?.token;
  if (token) {
    const u = ctx.db.get<User>('SELECT * FROM users WHERE api_token = ? AND is_active = 1', [token]);
    if (!u) throw unauthenticated('Invalid API token.');
    return u;
  }
  const session = req.cookies?.[SESSION_COOKIE];
  if (session) {
    const u = ctx.db.get<User>(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1`,
      [sha256(session), new Date().toISOString()],
    );
    return u ?? null;
  }
  return null;
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw unauthenticated();
  return req.user;
}

/** Set Tracker-style pagination headers. */
export function paginate(reply: FastifyReply, total: number, limit: number, offset: number, returned: number) {
  reply.header('X-Tracker-Pagination-Total', String(total));
  reply.header('X-Tracker-Pagination-Limit', String(limit));
  reply.header('X-Tracker-Pagination-Offset', String(offset));
  reply.header('X-Tracker-Pagination-Returned', String(returned));
}
