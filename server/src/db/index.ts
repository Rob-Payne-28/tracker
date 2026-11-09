import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { migrations } from './migrations.js';

export type Params = Record<string, SQLInputValue> | SQLInputValue[];
export type Row = Record<string, any>;

/** Thin synchronous wrapper around node:sqlite with transaction support. */
export class Database {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  private migrate() {
    const current = (this.raw.prepare('PRAGMA user_version').get() as Row).user_version as number;
    for (let i = current; i < migrations.length; i++) {
      this.tx(() => {
        this.raw.exec(migrations[i]);
        this.raw.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  private bind(params?: Params): SQLInputValue[] {
    if (params === undefined) return [];
    return Array.isArray(params) ? params : [params as any];
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    return this.raw.prepare(sql).all(...this.bind(params)) as T[];
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    return this.raw.prepare(sql).get(...this.bind(params)) as T | undefined;
  }

  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...this.bind(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Insert a row from an object and return the new id. */
  insert(table: string, values: Record<string, SQLInputValue>): number {
    const keys = Object.keys(values);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => '$' + k).join(', ')})`;
    return this.run(sql, values).lastInsertRowid;
  }

  /** Update columns of a row by id. */
  update(table: string, id: number, values: Record<string, SQLInputValue>): void {
    const keys = Object.keys(values);
    if (!keys.length) return;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = $${k}`).join(', ')} WHERE id = $__id`;
    this.run(sql, { ...values, __id: id });
  }

  /** Run fn inside a transaction (nested calls use savepoints). */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (e) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  close() {
    this.raw.close();
  }
}

export const now = () => new Date().toISOString();
