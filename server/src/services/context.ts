import { EventEmitter } from 'node:events';
import type { Config } from '../config.js';
import { Database } from '../db/index.js';
import { Mailer } from './mailer.js';

export interface StreamEvent {
  type: 'activity' | 'notification' | 'project';
  project_id?: number;
  user_id?: number;
  data: unknown;
}

/** In-process pub/sub used for Server-Sent Events. Channels: `project:<id>` and `user:<id>`. */
export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }
  publish(channel: string, event: StreamEvent) {
    this.emit(channel, event);
  }
}

export class Ctx {
  readonly db: Database;
  readonly events = new EventBus();
  readonly mailer: Mailer;
  private pending: (() => void)[] = [];
  private depth = 0;

  constructor(readonly config: Config) {
    this.db = new Database(config.databaseFile);
    this.mailer = new Mailer(config);
  }

  /**
   * Run fn in a database transaction. Callbacks registered with afterCommit() run only once the
   * outermost transaction commits (used for realtime events, webhooks and email).
   */
  tx<T>(fn: () => T): T {
    this.depth++;
    let result: T;
    try {
      result = this.db.tx(fn);
    } catch (e) {
      this.depth--;
      if (this.depth === 0) this.pending = [];
      throw e;
    }
    this.depth--;
    if (this.depth === 0) {
      const jobs = this.pending;
      this.pending = [];
      for (const job of jobs) {
        try {
          job();
        } catch (err) {
          console.error('afterCommit job failed', err);
        }
      }
    }
    return result;
  }

  afterCommit(fn: () => void) {
    if (this.depth === 0) fn();
    else this.pending.push(fn);
  }

  setting(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value;
  }

  setSetting(key: string, value: string) {
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      key,
      value,
    ]);
  }

  /** Signup allowed? Instance setting overrides env default. */
  signupAllowed(): boolean {
    const s = this.setting('allow_signup');
    return s === undefined ? this.config.allowSignup : s === 'true';
  }

  close() {
    this.db.close();
  }
}
