/**
 * API contract snapshot: the OpenAPI document generated from the live route schemas must match the
 * committed docs/openapi.json. Any change to an endpoint, parameter or response shape therefore shows
 * up as a reviewable diff (run `npm run openapi` to accept an intentional change).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testApp } from './helpers.js';

const committedPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../docs/openapi.json');

test('generated OpenAPI document matches docs/openapi.json (run `npm run openapi` after intentional API changes)', async () => {
  const app = await testApp();
  try {
    const live = JSON.parse(JSON.stringify(app.swagger()));
    const committed = JSON.parse(fs.readFileSync(committedPath, 'utf8'));
    // The servers block reflects BASE_URL, which differs between environments.
    delete live.servers;
    delete committed.servers;
    const livePaths = Object.keys(live.paths).sort();
    const committedPaths = Object.keys(committed.paths).sort();
    assert.deepEqual(livePaths, committedPaths, 'set of API paths changed');
    for (const p of livePaths) {
      assert.deepEqual(live.paths[p], committed.paths[p], `contract changed for ${p}`);
    }
    assert.deepEqual(live.components, committed.components, 'shared schemas changed');
    assert.deepEqual(live, committed);
  } finally {
    await app.cleanup();
  }
});
