import { buildApp } from './app.js';

const app = await buildApp();
const { port, host, baseUrl, databaseFile } = app.ctx.config;

try {
  await app.listen({ port, host });
  app.log.info(`Tracker running at ${baseUrl} (database: ${databaseFile})`);
  app.log.info(`API docs: ${baseUrl}/api/docs`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
