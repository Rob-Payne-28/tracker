/** Writes the OpenAPI document to docs/openapi.json (run: npm run openapi). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../app.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-openapi-'));
const app = await buildApp({ dataDir, databaseFile: ':memory:', logLevel: 'silent', baseUrl: 'https://tracker.example.com', webDist: null });
await app.ready();
const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../docs/openapi.json');
fs.writeFileSync(out, JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`Wrote ${out}`);
