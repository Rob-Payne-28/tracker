/**
 * End-to-end smoke test: runs the production build in a real browser.
 *
 *   npm run build && npm run test:e2e
 *
 * Covers the flows that unit/API tests cannot: the SPA boots under its Content-Security-Policy,
 * cookie-authenticated mutations pass the CSRF origin check, drag-and-drop prioritisation, the
 * story workflow buttons, comments, live updates between two browser sessions, and analytics.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
let server;
let browser;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-e2e-'));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/dist/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, BASE_URL: BASE, LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});

after(async () => {
  await browser?.close();
  server?.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A page that records uncaught errors and CSP violations. */
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/401 \(Unauthorized\)/.test(m.text())) page.errors.push(m.text());
  });
  return page;
}

test('setup, planning workflow, drag and drop, comments, live updates and analytics', async () => {
  const page = await newPage();

  // First visit to a fresh instance goes to setup; the first account becomes admin.
  await page.goto(BASE);
  await page.getByText('Set up your Tracker').waitFor();
  await page.getByLabel('Full name').fill('Erin Engineer');
  await page.getByLabel('Email').fill('erin@example.com');
  await page.getByLabel(/^Password/).fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();

  // Create a project (cookie-authenticated POST → exercises the CSRF origin check).
  await page.getByRole('button', { name: '+ Create project' }).click();
  await page.getByLabel('Project name').fill('E2E Project');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.locator('.panel-current').waitFor();

  // Add stories with the keyboard shortcut.
  for (const name of ['First story', 'Second story']) {
    await page.locator('body').press('a');
    await page.locator('.new-story textarea').first().fill(name);
    await page.locator('.new-story textarea').first().press('Enter');
    await page.locator('.story', { hasText: name }).waitFor();
  }
  // Add an icebox story via the panel button.
  await page.locator('.panel-icebox .add-story').click();
  await page.locator('.panel-icebox .new-story textarea').first().fill('Iced idea');
  await page.locator('.panel-icebox .new-story textarea').first().press('Enter');
  await page.locator('.panel-icebox .story', { hasText: 'Iced idea' }).waitFor();

  // Estimate, then walk the workflow with the preview buttons.
  const first = () => page.locator('.panel-current .story', { hasText: 'First story' });
  await first().locator('.est-btn', { hasText: /^3$/ }).click();
  for (const button of ['Start', 'Finish', 'Deliver', 'Accept']) {
    await first().locator('.state-btn', { hasText: button }).click();
    await first().locator('.state-btn').first().or(first().locator('.estimate')).first().waitFor();
    await page.waitForTimeout(150);
  }
  assert.ok(await page.locator('.panel-current .story.state-accepted', { hasText: 'First story' }).count(), 'story accepted');

  // Drag the icebox story above "Second story".
  await page.locator('.panel-icebox .story', { hasText: 'Iced idea' }).dragTo(page.locator('.panel-current .story', { hasText: 'Second story' }), { targetPosition: { x: 40, y: 2 } });
  await page.locator('.panel-current .story', { hasText: 'Iced idea' }).waitFor();
  const names = await page.locator('.panel-current .story .story-name').allInnerTexts();
  assert.ok(names.findIndex((n) => n.includes('Iced idea')) < names.findIndex((n) => n.includes('Second story')), `drag order: ${names}`);

  // A second session sees changes live (Server-Sent Events).
  const projectUrl = page.url();
  const other = await newPage();
  await other.context().addCookies(await page.context().cookies());
  await other.goto(projectUrl);
  await other.locator('.panel-current .story', { hasText: 'Second story' }).waitFor();

  // Expand a story and comment on it.
  await page.locator('.panel-current .story', { hasText: 'Second story' }).locator('.story-name').click();
  await page.locator('.story-editor textarea[placeholder^="Add a comment"]').fill('Looks good to me');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await page.locator('.comment', { hasText: 'Looks good to me' }).waitFor();
  await other.locator('.panel-current .story', { hasText: 'Second story' }).locator('.meta-icon', { hasText: '💬1' }).waitFor({ timeout: 5000 });

  // Analytics renders charts.
  await page.getByRole('link', { name: 'Analytics' }).click();
  await page.locator('.chart svg').first().waitFor();

  assert.deepEqual(page.errors, [], 'no browser errors (including CSP violations)');
  assert.deepEqual(other.errors, []);
});

test('cross-site requests with the session cookie are rejected', async () => {
  const page = await newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email or username').fill('erin@example.com');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.project-card').waitFor();
  const cookie = (await page.context().cookies()).find((c) => c.name === 'tracker_session');
  const res = await fetch(`${BASE}/api/v1/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `tracker_session=${cookie.value}`, Origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'CSRF' }),
  });
  assert.equal(res.status, 403);
});
