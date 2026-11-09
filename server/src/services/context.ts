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

/**
 * Something that reacts to project activity after it is committed: the realtime stream, webhooks,
 * and any future integration (chat notifications, audit export, …). Register with Ctx.onActivity().
 * Sinks must not throw and must not block: do slow work asynchronously.
 */
export type ActivitySink = (projectId: number, activity: { kind: string } & Record<string, unknown>) => void;

/** Tracks open realtime streams so they can be capped per user and closed on shutdown. */
export class StreamRegistry {
  private byUser = new Map<number, Set<() => void>>();
  constructor(private maxPerUser: number) {}

  /** Register a stream; returns a release function, or null when the user is at the cap. */
  open(userId: number, end: () => void): (() => void) | null {
    const set = this.byUser.get(userId) ?? new Set();
    if (set.size >= this.maxPerUser) return null;
    set.add(end);
    this.byUser.set(userId, set);
    return () => {
      set.delete(end);
      if (!set.size) this.byUser.delete(userId);
    };
  }

  closeAll() {
    for (const set of [...this.byUser.values()]) for (const end of [...set]) end();
    this.byUser.clear();
  }
}

export class Ctx {
  readonly db: Database;
  readonly events = new EventBus();
  readonly streams: StreamRegistry;
  readonly mailer: Mailer;
  private pending: (() => void)[] = [];
  private depth = 0;
  private sinks: { name: string; sink: ActivitySink }[] = [];

  /** Register an activity sink. Returns an unsubscribe function. */
  onActivity(name: string, sink: ActivitySink): () => void {
    const entry = { name, sink };
    this.sinks.push(entry);
    return () => {
      this.sinks = this.sinks.filter((e) => e !== entry);
    };
  }

  /** Deliver a committed activity to every sink, isolating failures. */
  emitActivity(projectId: number, activity: { kind: string } & Record<string, unknown>) {
    for (const { name, sink } of this.sinks) {
      try {
        sink(projectId, activity);
      } catch (err) {
        console.error(`activity sink "${name}" failed`, err);
      }
    }
  }

  constructor(readonly config: Config) {
    this.db = new Database(config.databaseFile);
    this.mailer = new Mailer(config);
    this.streams = new StreamRegistry(config.maxStreamsPerUser);
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
