import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5173';
const OUT = 'docs/screens';
mkdirSync(OUT, { recursive: true });

function start(cmd, args, env, waitText, port) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${cmd}: ${log}`)), 30000);
    const onData = (d) => {
      log += String(d);
      if (log.includes(waitText)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`${cmd} exited ${code}: ${log}`)));
  });
}

const api = await start('node', ['--env-file=.env', 'scripts/dev-api.mjs'], {}, 'dev-api:', 8787);
const vite = await start('pnpm', ['dev'], {}, 'Local:', 5173);

const browser = await chromium.launch();
const shots = [];

async function newPage(lang = 'hi') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.evaluate((l) => window.localStorage.setItem('fc.lang', l), lang);
  await page.reload({ waitUntil: 'networkidle' });
  return { context, page };
}

async function login(page, username) {
  await page.fill('#username', username);
  await page.fill('#pin', '1234');
  await page.getByRole('button', { name: /Sign in|साइन इन/ }).click();
  await page.waitForURL('**/today', { timeout: 15000 });
  await page.getByTestId('skeleton').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function shoot(page, name) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  shots.push(name);
  console.log('shot:', name);
}

function setLang(page, lang, label) {
  return page.evaluate((l) => window.localStorage.setItem('fc.lang', l), lang).then(() => page.reload({ waitUntil: 'networkidle' })).then(() => page.getByRole('button', { name: label }).first().waitFor({ timeout: 10000 }));
}

// --- login (default lang hi) ---
const loginCtx = await newPage('hi');
await loginCtx.page.getByText('साइन इन करें').first().waitFor({ timeout: 10000 });
await shoot(loginCtx.page, 'login-hi');
await loginCtx.page.getByRole('button', { name: 'English', exact: true }).click();
await loginCtx.page.getByText('Sign in', { exact: true }).first().waitFor({ timeout: 10000 });
await shoot(loginCtx.page, 'login-en');

// --- today (English) ---
await loginCtx.page.evaluate(() => window.localStorage.setItem('fc.lang', 'en'));
await login(loginCtx.page, 'arjun.verma');
await shoot(loginCtx.page, 'today-en');

// --- detail (English) ---
await loginCtx.page.locator('button.card').first().click();
await loginCtx.page.waitForURL('**/loans/**', { timeout: 10000 });
await loginCtx.page.waitForTimeout(400);
await shoot(loginCtx.page, 'detail-en');

// --- me + switch to Hindi ---
await loginCtx.page.getByRole('button', { name: 'Me' }).click();
await loginCtx.page.waitForURL('**/me', { timeout: 10000 });
await shoot(loginCtx.page, 'me-en');
await loginCtx.page.getByRole('group').getByRole('button', { name: 'हिंदी' }).click();
await loginCtx.page.waitForTimeout(300);
await shoot(loginCtx.page, 'me-hi');

// --- today + detail (Hindi) ---
await loginCtx.page.getByRole('button', { name: 'आज' }).click();await loginCtx.page.waitForURL('**/today', { timeout: 10000 });
await loginCtx.page.waitForTimeout(300);
await shoot(loginCtx.page, 'today-hi');
await loginCtx.page.locator('button.card').first().click();
await loginCtx.page.waitForURL('**/loans/**', { timeout: 10000 });
await loginCtx.page.waitForTimeout(400);
await shoot(loginCtx.page, 'detail-hi');
await loginCtx.context.close();

// --- empty state (fresh context, empty assignments fulfilled) ---
const emptyCtx = await newPage('en');
await emptyCtx.page.route('**/api/me/assignments', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assignments: [] }) })
);
await login(emptyCtx.page, 'arjun.verma');
await emptyCtx.page.getByTestId('empty').waitFor({ timeout: 10000 });
await shoot(emptyCtx.page, 'today-empty-en');
await emptyCtx.page.evaluate(() => window.localStorage.setItem('fc.lang', 'hi'));
await emptyCtx.page.reload({ waitUntil: 'networkidle' });
await emptyCtx.page.getByTestId('empty').waitFor({ timeout: 10000 });
await shoot(emptyCtx.page, 'today-empty-hi');
await emptyCtx.context.close();

// --- error state (fresh context, assignments aborted) ---
const errCtx = await newPage('en');
await errCtx.page.route('**/api/me/assignments', (route) => route.abort());
await login(errCtx.page, 'arjun.verma');
await errCtx.page.getByTestId('error').waitFor({ timeout: 10000 });
await shoot(errCtx.page, 'today-error-en');
await errCtx.page.evaluate(() => window.localStorage.setItem('fc.lang', 'hi'));
await errCtx.page.reload({ waitUntil: 'networkidle' });
await errCtx.page.getByTestId('error').waitFor({ timeout: 10000 });
await shoot(errCtx.page, 'today-error-hi');
await errCtx.context.close();

// --- offline banner (cache renders, banner shows) ---
const offCtx = await newPage('en');
await login(offCtx.page, 'arjun.verma');
await offCtx.page.waitForSelector('.card', { timeout: 10000 });
await offCtx.context.setOffline(true);
await offCtx.page.getByTestId('offline-banner').waitFor({ timeout: 15000 });
await shoot(offCtx.page, 'today-offline-en');
await offCtx.context.close();

await browser.close();
api.kill();
vite.kill();
console.log(`done: ${shots.length} screenshots -> ${shots.join(', ')}`);
process.exit(0);
