import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { requireUser } from '../app.js';
import { ref, Ok, ProjectParams } from '../schemas.js';
import { access } from '../services/projects.js';
import { attachmentJson } from '../services/stories.js';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { randomToken } from '../lib/auth.js';
import { now } from '../db/index.js';

export const uploadDir = (dataDir: string) => path.join(dataDir, 'uploads');

const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|text\/plain|application\/pdf|video\/(mp4|webm)|audio\/)/;

export async function attachmentRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const db = ctx.db;
  const dir = uploadDir(ctx.config.dataDir);
  fs.mkdirSync(dir, { recursive: true });

  app.post(
    '/projects/:project_id/uploads',
    {
      schema: {
        tags: ['Attachments'],
        summary: 'Upload a file',
        description:
          'Upload a file as `multipart/form-data` (field name `file`). Returns a file attachment that is not yet attached to anything; pass its id in `file_attachment_ids` when creating a comment. Unattached uploads are removed after 24 hours.',
        params: ProjectParams,
        consumes: ['multipart/form-data'],
        response: { 201: ref('FileAttachment') },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      const a = access(ctx, Number((req.params as any).project_id), u, 'member');
      if (!req.isMultipart()) throw badRequest('Send the file as multipart/form-data with field name "file".');
      const file = await req.file();
      if (!file) throw badRequest('No file was uploaded.');
      const key = randomToken(16);
      const dest = path.join(dir, key);
      try {
        await pipeline(file.file, fs.createWriteStream(dest));
      } catch (e) {
        fs.rmSync(dest, { force: true });
        throw e;
      }
      if (file.file.truncated) {
        fs.rmSync(dest, { force: true });
        throw new ApiError(413, 'request_too_large', `File exceeds the ${Math.round(ctx.config.maxUploadBytes / 1048576)} MB limit.`);
      }
      const size = fs.statSync(dest).size;
      const id = db.insert('attachments', {
        project_id: a.project.id,
        comment_id: null,
        uploader_id: u.id,
        filename: path.basename(file.filename || 'file').slice(0, 255),
        content_type: file.mimetype || 'application/octet-stream',
        size,
        storage_key: key,
        created_at: now(),
      });
      return reply.status(201).send(attachmentJson(ctx, db.get('SELECT * FROM attachments WHERE id = ?', [id])!));
    },
  );

  app.get(
    '/attachments/:id/download',
    {
      config: { allowQueryToken: true },
      schema: {
        tags: ['Attachments'],
        summary: 'Download a file',
        description: 'Streams the file. Images, PDFs, audio/video and plain text are served inline; other types as downloads. Accepts `?token=` for use in links.',
        params: Type.Object({ id: Type.Integer() }),
        querystring: Type.Object({ token: Type.Optional(Type.String()), download: Type.Optional(Type.Boolean()) }),
      },
    },
    async (req, reply) => {
      const f = db.get('SELECT * FROM attachments WHERE id = ?', [(req.params as any).id]);
      if (!f) throw notFound('File');
      access(ctx, f.project_id, req.user, 'viewer');
      const p = path.join(dir, f.storage_key);
      if (!fs.existsSync(p)) throw notFound('File');
      const inline = INLINE_TYPES.test(f.content_type) && !(req.query as any).download;
      reply.header('Content-Type', inline ? f.content_type : 'application/octet-stream');
      reply.header('Content-Length', String(f.size));
      reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      reply.header('Cache-Control', 'private, max-age=86400');
      return reply.send(fs.createReadStream(p));
    },
  );

  app.delete(
    '/projects/:project_id/uploads/:id',
    {
      schema: {
        tags: ['Attachments'],
        summary: 'Delete a file',
        description: 'The uploader or a project owner can delete a file (it is removed from its comment).',
        params: Type.Object({ project_id: Type.Integer(), id: Type.Integer() }),
        response: { 200: ref(Ok) },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const a = access(ctx, Number((req.params as any).project_id), u, 'member');
      const f = db.get('SELECT * FROM attachments WHERE id = ? AND project_id = ?', [(req.params as any).id, a.project.id]);
      if (!f) throw notFound('File');
      if (f.uploader_id !== u.id && a.role !== 'owner') throw forbidden('You can only delete files you uploaded.');
      db.run('DELETE FROM attachments WHERE id = ?', [f.id]);
      fs.rmSync(path.join(dir, f.storage_key), { force: true });
      return { ok: true };
    },
  );
}
