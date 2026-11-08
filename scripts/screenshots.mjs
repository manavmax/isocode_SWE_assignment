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

// Never leave orphan servers behind on a crash (they poison the next run's
// ports 5173/8787).
function cleanup() {
  try { api.kill('SIGKILL'); } catch {}
  try { vite.kill('SIGKILL'); } catch {}
}
process.on('uncaughtException', (err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});

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
  await page.waitForURL(/\/(today|dashboard)/, { timeout: 15000 });
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

/** Capture the loan-detail sheets: Outcome (chips + promise date chips),
 * the 5 s Undo toast after a Paid save, and the Blocked-by-window sheet
 * with the clock frozen outside 08:00–19:00 IST. */
async function shootDetailSheets(page, lang) {
  await page.locator('button.sticky-btn-accent').click();
  await page.waitForSelector('dialog.outcome-sheet');
  await shoot(page, `outcome-${lang}`);
  await page.getByRole('button', { name: /Promise to pay|भुगतान का वादा/ }).click();
  await page.waitForTimeout(200);
  await shoot(page, `outcome-promise-${lang}`);
  await page.getByRole('button', { name: /Cancel|रद्द करें/ }).click();
  await page.waitForSelector('dialog.outcome-sheet', { state: 'detached' });

  await page.locator('button.sticky-btn-accent').click();
  await page.getByRole('button', { name: /Paid|भुगतान किया/ }).click();
  await page.getByRole('button', { name: /Save|सहेजें/ }).click();
  await page.waitForSelector('.undo-toast');
  await shoot(page, `undo-${lang}`);
  await page.waitForSelector('.undo-toast', { state: 'detached', timeout: 8000 });

  await page.clock.setFixedTime(new Date('2026-11-06T16:30:00Z'));
  await page.locator('button.sticky-btn').first().click();
  await page.waitForSelector('dialog.blocked-sheet');
  await shoot(page, `blocked-${lang}`);
  await page.getByRole('button', { name: /Close|बंद करें/ }).click();
  await page.waitForSelector('dialog.blocked-sheet', { state: 'detached' });
  await page.clock.setFixedTime(new Date());
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

// --- detail (English) + sheets ---
await loginCtx.page.locator('button.card').first().click();
await loginCtx.page.waitForURL('**/loans/**', { timeout: 10000 });
await loginCtx.page.waitForTimeout(400);
await shoot(loginCtx.page, 'detail-en');
await shootDetailSheets(loginCtx.page, 'en');

// --- me (English): sync section with the just-queued item ---
await loginCtx.page.locator('nav.bottom-nav').getByRole('button', { name: 'Me' }).click();
await loginCtx.page.waitForURL('**/me', { timeout: 10000 });
await shoot(loginCtx.page, 'me-en');
await loginCtx.page.getByRole('group').getByRole('button', { name: 'हिंदी' }).click();
await loginCtx.page.waitForTimeout(300);
await shoot(loginCtx.page, 'me-hi');

// --- today + detail (Hindi) + sheets ---
await loginCtx.page.goto(`${BASE}/today`, { waitUntil: 'networkidle' });
await loginCtx.page.waitForTimeout(400);
await loginCtx.page.waitForTimeout(300);
await shoot(loginCtx.page, 'today-hi');
await loginCtx.page.locator('button.card').first().click();
await loginCtx.page.waitForURL('**/loans/**', { timeout: 10000 });
await loginCtx.page.waitForTimeout(400);
await shoot(loginCtx.page, 'detail-hi');
await shootDetailSheets(loginCtx.page, 'hi');
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

// --- promises (prompt 11 item 5): demo-officer-1 (Rahul) has a rich day ---
const promCtx = await newPage('en');
await login(promCtx.page, 'demo-officer-1');
await promCtx.page.locator('nav.bottom-nav').getByRole('button', { name: /Promises|वादे/ }).click();
await promCtx.page.waitForURL('**/promises', { timeout: 10000 });
await promCtx.page.waitForTimeout(700);
await shoot(promCtx.page, 'promises-due-en');
// Log-outcome sheet on the first card (same sheet as the detail screen).
await promCtx.page.locator('.promise-card .btn-accent').first().click();
await promCtx.page.waitForSelector('dialog.outcome-sheet', { timeout: 10000 });
await shoot(promCtx.page, 'promises-outcome-en');
await promCtx.page.getByRole('button', { name: /Cancel|रद्द करें/ }).click();
await promCtx.page.waitForSelector('dialog.outcome-sheet', { state: 'detached' });
await promCtx.page.getByRole('tab', { name: 'Upcoming' }).click();
await promCtx.page.waitForTimeout(300);
await shoot(promCtx.page, 'promises-upcoming-en');
await promCtx.page.getByRole('tab', { name: 'Broken' }).click();
await promCtx.page.waitForTimeout(300);
await shoot(promCtx.page, 'promises-broken-en');
await promCtx.page.evaluate(() => window.localStorage.setItem('fc.lang', 'hi'));
await promCtx.page.reload({ waitUntil: 'networkidle' });
await promCtx.page.getByRole('tab', { name: 'आज देने हैं' }).waitFor({ timeout: 10000 });
await promCtx.page.waitForTimeout(300);
await shoot(promCtx.page, 'promises-due-hi');
await promCtx.page.getByRole('tab', { name: 'टूटे' }).click();
await promCtx.page.waitForTimeout(300);
await shoot(promCtx.page, 'promises-broken-hi');
await promCtx.context.close();

// --- promises empty state: demo-officer-3, the territory-less joiner ---
const promEmptyCtx = await newPage('hi');
await login(promEmptyCtx.page, 'demo-officer-3');
await promEmptyCtx.page.locator('nav.bottom-nav').getByRole('button', { name: /Promises|वादे/ }).click();
await promEmptyCtx.page.waitForURL('**/promises', { timeout: 10000 });
await promEmptyCtx.page.waitForTimeout(700);
await shoot(promEmptyCtx.page, 'promises-empty-hi');
await promEmptyCtx.context.close();

// --- manager screens (prompt 13): dashboard desktop+phone, import, activity ---
const mgrCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const mgrPage = await mgrCtx.newPage();
await mgrPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await mgrPage.evaluate(() => window.localStorage.setItem('fc.lang', 'en'));
await mgrPage.reload({ waitUntil: 'networkidle' });
await mgrPage.fill('#username', 'demo-manager');
await mgrPage.fill('#pin', '1234');
await mgrPage.getByRole('button', { name: /Sign in/ }).click();
await mgrPage.waitForURL('**/dashboard', { timeout: 15000 });
await mgrPage.waitForSelector('.tile-grid', { timeout: 15000 });
await mgrPage.waitForTimeout(500);
await shoot(mgrPage, 'manager-dashboard-desktop');
await mgrPage.locator('nav.bottom-nav').getByRole('button', { name: 'Import' }).click();
await mgrPage.waitForURL('**/import', { timeout: 10000 });
await mgrPage.waitForTimeout(500);
await shoot(mgrPage, 'manager-import-desktop');
await mgrPage.locator('nav.bottom-nav').getByRole('button', { name: 'Dashboard' }).click();
await mgrPage.waitForURL('**/dashboard', { timeout: 10000 });
await mgrPage.getByRole('button', { name: /Last 50 events/ }).first().click();
await mgrPage.waitForURL('**/manager/officers/**', { timeout: 10000 });
await mgrPage.waitForTimeout(600);
await shoot(mgrPage, 'manager-activity-desktop');
await mgrCtx.close();

const mgrPhoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mgrPhone = await mgrPhoneCtx.newPage();
await mgrPhone.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await mgrPhone.evaluate(() => window.localStorage.setItem('fc.lang', 'en'));
await mgrPhone.reload({ waitUntil: 'networkidle' });
await mgrPhone.fill('#username', 'demo-manager');
await mgrPhone.fill('#pin', '1234');
await mgrPhone.getByRole('button', { name: /Sign in/ }).click();
await mgrPhone.waitForURL('**/dashboard', { timeout: 15000 });
await mgrPhone.waitForSelector('.tile-grid', { timeout: 15000 });
await mgrPhone.waitForTimeout(500);
await shoot(mgrPhone, 'manager-dashboard-phone');
await mgrPhoneCtx.close();

await browser.close();
api.kill();
vite.kill();
console.log(`done: ${shots.length} screenshots -> ${shots.join(', ')}`);
process.exit(0);
