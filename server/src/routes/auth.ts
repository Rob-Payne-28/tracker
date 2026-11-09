import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { SESSION_COOKIE, VERSION, requireUser } from '../app.js';
import { hashPassword, initialsFor, randomToken, sha256, usernameFrom, verifyPassword } from '../lib/auth.js';
import { ApiError, badRequest, conflict, forbidden, unauthenticated } from '../lib/errors.js';
import { meJson, uniqueUsername, type User } from '../services/people.js';
import { now } from '../db/index.js';
import { isValidTimeZone } from '../lib/dates.js';
import { ref, Ok } from '../schemas.js';
import type { Ctx } from '../services/context.js';

const attempts = new Map<string, { n: number; until: number }>();
function throttle(key: string) {
  const a = attempts.get(key);
  if (a && a.n >= 10 && a.until > Date.now()) throw new ApiError(429, 'too_many_requests', 'Too many failed attempts. Try again in a few minutes.');
}
function failed(key: string) {
  const a = attempts.get(key);
  const n = a && a.until > Date.now() ? a.n + 1 : 1;
  attempts.set(key, { n, until: Date.now() + 10 * 60_000 });
}

export function startSession(ctx: Ctx, reply: FastifyReply, userId: number) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + ctx.config.sessionDays * 86400_000);
  ctx.db.insert('sessions', { token_hash: sha256(token), user_id: userId, created_at: now(), expires_at: expires.toISOString() });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.baseUrl.startsWith('https://'),
    expires,
  });
}

export function validatePassword(p: string) {
  if (p.length < 8) throw badRequest('Password must be at least 8 characters.');
}

export function createUser(ctx: Ctx, input: { name: string; email: string; password?: string | null; username?: string; is_admin?: boolean }) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('A valid email address is required.');
  if (ctx.db.get('SELECT 1 FROM users WHERE email = ?', [email])) throw conflict('An account with that email already exists.');
  const name = input.name.trim() || email.split('@')[0];
  if (input.username) {
    if (!/^[a-z0-9_]{2,30}$/i.test(input.username)) throw badRequest('Username may contain letters, digits and underscores (2–30 chars).');
    if (ctx.db.get('SELECT 1 FROM users WHERE username = ?', [input.username])) throw conflict('That username is taken.');
  }
  const ts = now();
  return ctx.db.insert('users', {
    email,
    name,
    initials: initialsFor(name),
    username: input.username ?? uniqueUsername(ctx, usernameFrom(name.replace(/\s+/g, '') || email)),
    password_hash: input.password ? hashPassword(input.password) : null,
    api_token: randomToken(20),
    is_admin: input.is_admin ? 1 : 0,
    created_at: ts,
    updated_at: ts,
  });
}

const MeRef = ref('Me');

export async function authRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get(
    '/instance',
    {
      schema: {
        tags: ['Account'],
        summary: 'Instance information',
        description: 'Public information about this server: whether sign-up is open and whether initial setup is required.',
        security: [],
        response: {
          200: Type.Object({
            version: Type.String(),
            signup_allowed: Type.Boolean(),
            needs_setup: Type.Boolean({ description: 'True when no accounts exist yet; the first sign-up becomes administrator.' }),
            email_enabled: Type.Boolean(),
          }),
        },
      },
    },
    async () => {
      const users = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
      return { version: VERSION, signup_allowed: users === 0 || ctx.signupAllowed(), needs_setup: users === 0, email_enabled: ctx.mailer.enabled };
    },
  );

  app.post(
    '/auth/signup',
    {
      schema: {
        tags: ['Account'],
        summary: 'Create an account',
        description: 'Creates an account and signs in (sets the session cookie). The first account on a fresh instance becomes the administrator.',
        security: [],
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 100 }),
          email: Type.String({ maxLength: 254 }),
          password: Type.String({ minLength: 8, maxLength: 200 }),
          username: Type.Optional(Type.String()),
        }),
        response: { 201: MeRef },
      },
    },
    async (req, reply) => {
      const body = req.body as any;
      const first = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n === 0;
      if (!first && !ctx.signupAllowed()) throw forbidden('Sign-up is disabled on this server. Ask an administrator for an invitation.');
      validatePassword(body.password);
      const id = ctx.tx(() => createUser(ctx, { ...body, is_admin: first }));
      startSession(ctx, reply, id);
      const u = ctx.db.get<User>('SELECT * FROM users WHERE id = ?', [id])!;
      return reply.status(201).send(meJson(u));
    },
  );

  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['Account'],
        summary: 'Sign in',
        description: 'Signs in with email (or username) and password, setting a session cookie. API clients should use the API token instead.',
        security: [],
        body: Type.Object({ email: Type.String({ description: 'Email address or username' }), password: Type.String() }),
        response: { 200: MeRef },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body as any;
      const key = `${req.ip}:${String(email).toLowerCase()}`;
      throttle(key);
      const u = ctx.db.get<User>('SELECT * FROM users WHERE (email = ? OR username = ?) AND is_active = 1', [email.trim(), email.trim()]);
      if (!u || !verifyPassword(password, u.password_hash)) {
        failed(key);
        throw unauthenticated('Invalid email or password.');
      }
      attempts.delete(key);
      startSession(ctx, reply, u.id);
      return meJson(u);
    },
  );

  app.post(
    '/auth/logout',
    { schema: { tags: ['Account'], summary: 'Sign out', description: 'Ends the current browser session.', response: { 200: ref(Ok) } } },
    async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );

  app.post(
    '/auth/password_reset',
    {
      schema: {
        tags: ['Account'],
        summary: 'Request a password reset',
        description: 'Emails a reset link if SMTP is configured. Always returns ok to avoid revealing which emails exist. Administrators can also generate reset links from the admin API.',
        security: [],
        body: Type.Object({ email: Type.String() }),
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const { email } = req.body as any;
      const u = ctx.db.get<User>('SELECT * FROM users WHERE email = ? AND is_active = 1', [email.trim()]);
      if (u) {
        const token = issueResetToken(ctx, u.id);
        void ctx.mailer.send(
          u.email,
          'Reset your Tracker password',
          `Someone requested a password reset for your account.\n\nReset it here (valid for 24 hours):\n${ctx.config.baseUrl}/reset-password?token=${token}\n\nIf this wasn't you, ignore this email.`,
        );
      }
      return { ok: true };
    },
  );

  app.post(
    '/auth/password_reset/confirm',
    {
      schema: {
        tags: ['Account'],
        summary: 'Complete a password reset',
        security: [],
        body: Type.Object({ token: Type.String(), password: Type.String({ minLength: 8 }) }),
        response: { 200: MeRef },
      },
    },
    async (req, reply) => {
      const { token, password } = req.body as any;
      validatePassword(password);
      const u = ctx.db.get<User>('SELECT * FROM users WHERE reset_token = ? AND reset_expires_at > ?', [sha256(token), now()]);
      if (!u) throw badRequest('This reset link is invalid or has expired.');
      ctx.db.run('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL, updated_at = ? WHERE id = ?', [
        hashPassword(password),
        now(),
        u.id,
      ]);
      ctx.db.run('DELETE FROM sessions WHERE user_id = ?', [u.id]);
      startSession(ctx, reply, u.id);
      return meJson(ctx.db.get<User>('SELECT * FROM users WHERE id = ?', [u.id])!);
    },
  );

  app.get(
    '/auth/invitation/:token',
    {
      schema: {
        tags: ['Account'],
        summary: 'Look up an invitation',
        security: [],
        params: Type.Object({ token: Type.String() }),
        response: { 200: Type.Object({ email: Type.String(), name: Type.String(), projects: Type.Array(Type.String()) }) },
      },
    },
    async (req) => {
      const u = ctx.db.get<User>('SELECT * FROM users WHERE invite_token = ?', [sha256((req.params as any).token)]);
      if (!u) throw badRequest('This invitation is invalid or has already been used.');
      const projects = ctx.db
        .all('SELECT p.name FROM memberships m JOIN projects p ON p.id = m.project_id WHERE m.user_id = ?', [u.id])
        .map((r) => r.name as string);
      return { email: u.email, name: u.name, projects };
    },
  );

  app.post(
    '/auth/invitation/:token/accept',
    {
      schema: {
        tags: ['Account'],
        summary: 'Accept an invitation',
        description: 'Sets name and password for an invited account and signs in.',
        security: [],
        params: Type.Object({ token: Type.String() }),
        body: Type.Object({ name: Type.String({ minLength: 1 }), password: Type.String({ minLength: 8 }) }),
        response: { 200: MeRef },
      },
    },
    async (req, reply) => {
      const { name, password } = req.body as any;
      validatePassword(password);
      const u = ctx.db.get<User>('SELECT * FROM users WHERE invite_token = ?', [sha256((req.params as any).token)]);
      if (!u) throw badRequest('This invitation is invalid or has already been used.');
      ctx.db.run('UPDATE users SET name = ?, initials = ?, password_hash = ?, invite_token = NULL, updated_at = ? WHERE id = ?', [
        name.trim(),
        initialsFor(name),
        hashPassword(password),
        now(),
        u.id,
      ]);
      startSession(ctx, reply, u.id);
      return meJson(ctx.db.get<User>('SELECT * FROM users WHERE id = ?', [u.id])!);
    },
  );

  // ---- Me

  app.get(
    '/me',
    { schema: { tags: ['Account'], summary: 'Get the authenticated user', description: 'Includes your API token.', response: { 200: MeRef } } },
    async (req) => meJson(requireUser(req)),
  );

  app.put(
    '/me',
    {
      schema: {
        tags: ['Account'],
        summary: 'Update your profile',
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          initials: Type.Optional(Type.String({ minLength: 1, maxLength: 4 })),
          username: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_]{2,30}$' })),
          email: Type.Optional(Type.String()),
          email_notifications: Type.Optional(Type.Boolean()),
          time_zone: Type.Optional(Type.String()),
          current_password: Type.Optional(Type.String({ description: 'Required to change email or password' })),
          new_password: Type.Optional(Type.String({ minLength: 8 })),
        }),
        response: { 200: MeRef },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const b = req.body as any;
      const upd: Record<string, any> = {};
      if (b.name) {
        upd.name = b.name.trim();
        if (!b.initials) upd.initials = initialsFor(upd.name);
      }
      if (b.initials) upd.initials = b.initials.toUpperCase();
      if (b.username && b.username.toLowerCase() !== u.username.toLowerCase()) {
        if (ctx.db.get('SELECT 1 FROM users WHERE username = ? AND id != ?', [b.username, u.id])) throw conflict('That username is taken.');
        upd.username = b.username;
      }
      if (b.time_zone) {
        if (!isValidTimeZone(b.time_zone)) throw badRequest('Unknown time zone.');
        upd.time_zone = b.time_zone;
      }
      if (b.email_notifications !== undefined) upd.email_notifications = b.email_notifications ? 1 : 0;
      if ((b.email && b.email.toLowerCase() !== u.email) || b.new_password) {
        if (u.password_hash && !verifyPassword(b.current_password ?? '', u.password_hash)) throw forbidden('Current password is incorrect.');
      }
      if (b.email && b.email.toLowerCase() !== u.email) {
        const email = b.email.trim().toLowerCase();
        if (ctx.db.get('SELECT 1 FROM users WHERE email = ? AND id != ?', [email, u.id])) throw conflict('That email is in use.');
        upd.email = email;
      }
      if (b.new_password) {
        validatePassword(b.new_password);
        upd.password_hash = hashPassword(b.new_password);
      }
      if (Object.keys(upd).length) ctx.db.update('users', u.id, { ...upd, updated_at: now() });
      return meJson(ctx.db.get<User>('SELECT * FROM users WHERE id = ?', [u.id])!);
    },
  );

  app.post(
    '/me/regenerate_api_token',
    { schema: { tags: ['Account'], summary: 'Regenerate your API token', description: 'The old token stops working immediately.', response: { 200: MeRef } } },
    async (req) => {
      const u = requireUser(req);
      ctx.db.run('UPDATE users SET api_token = ?, updated_at = ? WHERE id = ?', [randomToken(20), now(), u.id]);
      return meJson(ctx.db.get<User>('SELECT * FROM users WHERE id = ?', [u.id])!);
    },
  );
}

export function issueResetToken(ctx: Ctx, userId: number): string {
  const token = randomToken(24);
  ctx.db.run('UPDATE users SET reset_token = ?, reset_expires_at = ? WHERE id = ?', [
    sha256(token),
    new Date(Date.now() + 86400_000).toISOString(),
    userId,
  ]);
  return token;
}
