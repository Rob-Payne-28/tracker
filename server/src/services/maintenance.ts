import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { uploadDir } from '../routes/attachments.js';

/**
 * Periodic housekeeping: expire sessions, drop unattached uploads older than a day, and remove
 * stored files whose attachment rows were deleted (e.g. via story or comment deletion cascades).
 */
export function runMaintenance(app: FastifyInstance) {
  const { db, config } = app.ctx;
  const nowIso = new Date().toISOString();
  db.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso]);
  db.run('DELETE FROM attachments WHERE comment_id IS NULL AND created_at < ?', [new Date(Date.now() - 86400_000).toISOString()]);
  const dir = uploadDir(config.dataDir);
  if (!fs.existsSync(dir)) return;
  const keys = new Set(db.all<{ storage_key: string }>('SELECT storage_key FROM attachments').map((r) => r.storage_key));
  const cutoff = Date.now() - 3600_000; // never touch very recent files (upload in flight)
  for (const name of fs.readdirSync(dir)) {
    if (keys.has(name)) continue;
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function startMaintenance(app: FastifyInstance) {
  let timer: NodeJS.Timeout | null = null;
  app.addHook('onReady', async () => {
    try {
      runMaintenance(app);
    } catch (e) {
      app.log.warn(e, 'maintenance failed');
    }
    timer = setInterval(() => {
      try {
        runMaintenance(app);
      } catch (e) {
        app.log.warn(e, 'maintenance failed');
      }
    }, 6 * 3600_000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
}
