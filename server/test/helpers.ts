import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';

export async function testApp(overrides: Partial<Config> = {}): Promise<FastifyInstance & { cleanup: () => Promise<void> }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-test-'));
  const app = await buildApp({
    dataDir,
    databaseFile: ':memory:',
    logLevel: 'silent',
    baseUrl: 'http://tracker.test',
    webDist: null,
    // Tests deliver webhooks to a receiver on 127.0.0.1; production blocks private addresses by default.
    webhookAllowPrivate: true,
    ...overrides,
  });
  await app.ready();
  return Object.assign(app, {
    cleanup: async () => {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  });
}

export class Client {
  constructor(
    private app: FastifyInstance,
    public token: string,
    public user: any,
  ) {}

  async req(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as any,
      url: url.startsWith('/api') ? url : `/api/v1${url}`,
      payload: payload as any,
      headers: { 'x-trackertoken': this.token, ...headers },
    });
    let body: any = res.body;
    try {
      body = JSON.parse(res.body);
    } catch {
      /* not json */
    }
    return { status: res.statusCode, body, headers: res.headers };
  }

  /** Request expecting a 2xx; throws with the error body otherwise. */
  async ok(method: string, url: string, payload?: unknown) {
    const r = await this.req(method, url, payload);
    if (r.status >= 300) throw new Error(`${method} ${url} -> ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  }
  get = (url: string) => this.ok('GET', url);
  post = (url: string, body?: unknown) => this.ok('POST', url, body ?? {});
  put = (url: string, body: unknown) => this.ok('PUT', url, body);
  del = (url: string) => this.ok('DELETE', url);
}

let n = 0;
export async function signup(app: FastifyInstance, name = `User ${++n}`): Promise<Client> {
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${n}.${Date.now()}@example.com`;
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { name, email, password: 'password123' } });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.body}`);
  const me = JSON.parse(res.body);
  return new Client(app, me.api_token, me);
}
