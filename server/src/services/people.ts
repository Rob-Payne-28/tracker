import type { Ctx } from './context.js';
import type { Row } from '../db/index.js';

export interface User {
  id: number;
  email: string;
  name: string;
  initials: string;
  username: string;
  password_hash: string | null;
  api_token: string;
  is_admin: number;
  is_active: number;
  invite_token: string | null;
  email_notifications: number;
  time_zone: string;
  created_at: string;
  updated_at: string;
}

export function personJson(u: Pick<User, 'id' | 'name' | 'email' | 'initials' | 'username'>) {
  return { kind: 'person', id: u.id, name: u.name, email: u.email, initials: u.initials, username: u.username };
}

export function meJson(u: User) {
  return {
    ...personJson(u),
    kind: 'me',
    api_token: u.api_token,
    is_admin: !!u.is_admin,
    email_notifications: !!u.email_notifications,
    time_zone: u.time_zone,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

export function getUser(ctx: Ctx, id: number): User | undefined {
  return ctx.db.get<User>('SELECT * FROM users WHERE id = ?', [id]);
}

export function peopleById(ctx: Ctx, ids: number[]): Map<number, Row> {
  if (!ids.length) return new Map();
  const rows = ctx.db.all('SELECT id, name, email, initials, username FROM users WHERE id IN (SELECT value FROM json_each(?))', [
    JSON.stringify([...new Set(ids)]),
  ]);
  return new Map(rows.map((r) => [r.id as number, r]));
}

/** Pick a unique username based on a seed. */
export function uniqueUsername(ctx: Ctx, seed: string): string {
  let base = seed || 'user';
  let candidate = base;
  let i = 1;
  while (ctx.db.get('SELECT 1 FROM users WHERE username = ?', [candidate])) {
    candidate = `${base}${++i}`;
  }
  return candidate;
}
