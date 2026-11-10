import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { requireUser } from '../app.js';
import { ref, Ok } from '../schemas.js';
import { forbidden, notFound, badRequest, conflict } from '../lib/errors.js';
import { createUser, issueResetToken, validatePassword } from './auth.js';
import { randomToken, sha256 } from '../lib/auth.js';
import { now } from '../db/index.js';
import type { User } from '../services/people.js';

const AdminUser = Type.Object({
  kind: Type.Literal('person'),
  id: Type.Integer(),
  name: Type.String(),
  email: Type.String(),
  initials: Type.String(),
  username: Type.String(),
  is_admin: Type.Boolean(),
  is_active: Type.Boolean(),
  invited: Type.Boolean({ description: 'Invitation not yet accepted' }),
  project_count: Type.Integer(),
  created_at: Type.String(),
});

export async function adminRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const db = ctx.db;
  const admin = (req: any): User => {
    const u = requireUser(req);
    if (!u.is_admin) throw forbidden('Administrator access required.');
    return u;
  };
  const userJson = (u: any) => ({
    kind: 'person',
    id: u.id,
    name: u.name,
    email: u.email,
    initials: u.initials,
    username: u.username,
    is_admin: !!u.is_admin,
    is_active: !!u.is_active,
    invited: !!u.invite_token,
    project_count: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?', [u.id])!.n,
    created_at: u.created_at,
  });

  app.get(
    '/admin/settings',
    {
      schema: {
        tags: ['Administration'],
        summary: 'Instance settings',
        response: { 200: Type.Object({ allow_signup: Type.Boolean(), base_url: Type.String(), email_enabled: Type.Boolean(), max_upload_mb: Type.Number() }) },
      },
    },
    async (req) => {
      admin(req);
      return {
        allow_signup: ctx.signupAllowed(),
        base_url: ctx.config.baseUrl,
        email_enabled: ctx.mailer.enabled,
        max_upload_mb: Math.round(ctx.config.maxUploadBytes / 1048576),
      };
    },
  );

  app.put(
    '/admin/settings',
    {
      schema: {
        tags: ['Administration'],
        summary: 'Update instance settings',
        body: Type.Object({ allow_signup: Type.Optional(Type.Boolean()) }),
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      admin(req);
      const b = req.body as any;
      if (b.allow_signup !== undefined) ctx.setSetting('allow_signup', String(!!b.allow_signup));
      return { ok: true };
    },
  );

  app.get(
    '/admin/users',
    { schema: { tags: ['Administration'], summary: 'List all users', response: { 200: Type.Array(AdminUser) } } },
    async (req) => {
      admin(req);
      return db.all('SELECT * FROM users ORDER BY name COLLATE NOCASE').map(userJson);
    },
  );

  app.post(
    '/admin/users',
    {
      schema: {
        tags: ['Administration'],
        summary: 'Create a user',
        description: 'Without a password, the user is invited and the response includes an `invite_url`.',
        body: Type.Object({
          name: Type.String({ minLength: 1 }),
          email: Type.String(),
          password: Type.Optional(Type.String({ minLength: 8 })),
          username: Type.Optional(Type.String()),
          is_admin: Type.Optional(Type.Boolean()),
        }),
        response: { 201: Type.Intersect([AdminUser, Type.Object({ invite_url: Type.Optional(Type.String()) })]) },
      },
    },
    async (req, reply) => {
      admin(req);
      const b = req.body as any;
      if (b.password) validatePassword(b.password);
      const id = createUser(ctx, b);
      let invite_url: string | undefined;
      if (!b.password) {
        const token = randomToken(24);
        db.run('UPDATE users SET invite_token = ? WHERE id = ?', [sha256(token), id]);
        invite_url = `${ctx.config.baseUrl}/invite/${token}`;
        void ctx.mailer.send(b.email, "You've been invited to Tracker", `Accept your invitation:\n${invite_url}`);
      }
      return reply.status(201).send({ ...userJson(db.get('SELECT * FROM users WHERE id = ?', [id])), ...(invite_url ? { invite_url } : {}) });
    },
  );

  app.put(
    '/admin/users/:id',
    {
      schema: {
        tags: ['Administration'],
        summary: 'Update a user',
        description: 'Deactivated users cannot sign in or use the API; their history is kept.',
        params: Type.Object({ id: Type.Integer() }),
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1 })),
          email: Type.Optional(Type.String()),
          is_admin: Type.Optional(Type.Boolean()),
          is_active: Type.Optional(Type.Boolean()),
        }),
        response: { 200: AdminUser },
      },
    },
    async (req) => {
      const me = admin(req);
      const id = (req.params as any).id;
      const u = db.get('SELECT * FROM users WHERE id = ?', [id]);
      if (!u) throw notFound('User');
      const b = req.body as any;
      if (id === me.id && (b.is_admin === false || b.is_active === false)) throw badRequest('You cannot demote or deactivate yourself.');
      if (b.email && db.get('SELECT 1 FROM users WHERE email = ? AND id != ?', [b.email.toLowerCase(), id])) throw conflict('That email is in use.');
      db.update('users', id, {
        ...(b.name ? { name: b.name.trim() } : {}),
        ...(b.email ? { email: b.email.trim().toLowerCase() } : {}),
        ...(b.is_admin !== undefined ? { is_admin: b.is_admin ? 1 : 0 } : {}),
        ...(b.is_active !== undefined ? { is_active: b.is_active ? 1 : 0 } : {}),
        updated_at: now(),
      });
      if (b.is_active === false) db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
      return userJson(db.get('SELECT * FROM users WHERE id = ?', [id]));
    },
  );

  app.post(
    '/admin/users/:id/password_reset_link',
    {
      schema: {
        tags: ['Administration'],
        summary: 'Generate a password reset link',
        description: 'For instances without email: share the link with the user. Valid for 24 hours.',
        params: Type.Object({ id: Type.Integer() }),
        response: { 200: Type.Object({ reset_url: Type.String() }) },
      },
    },
    async (req) => {
      admin(req);
      const id = (req.params as any).id;
      if (!db.get('SELECT 1 FROM users WHERE id = ?', [id])) throw notFound('User');
      return { reset_url: `${ctx.config.baseUrl}/reset-password?token=${issueResetToken(ctx, id)}` };
    },
  );

  app.delete(
    '/admin/users/:id',
    {
      schema: {
        tags: ['Administration'],
        summary: 'Delete a user',
        description: 'Removes the account and memberships. Stories and comments remain (attributed to nobody). Prefer deactivation.',
        params: Type.Object({ id: Type.Integer() }),
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const me = admin(req);
      const id = (req.params as any).id;
      if (id === me.id) throw badRequest('You cannot delete yourself.');
      if (!db.get('SELECT 1 FROM users WHERE id = ?', [id])) throw notFound('User');
      db.run('DELETE FROM users WHERE id = ?', [id]);
      return { ok: true };
    },
  );
}
