import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5173';

function start(cmd, args, env, waitText) {
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
  });
}

const api = await start('node', ['--env-file=.env', 'scripts/dev-api.mjs'], {}, 'dev-api:');
const vite = await start('pnpm', ['dev'], {}, 'Local:');

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
let totalFindings = 0;
const iPhoneEmulation = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

const AUDIT = () => {
  const overflowX = document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth;
  const smallTargets = [...document.querySelectorAll('button, a.btn, a.chip, [role="button"]')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ label: (el.textContent ?? '').trim().slice(0, 24), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }))
    .filter((t) => t.h < 44 || (t.w < 44 && t.h < 44));
  const truncated = [...document.querySelectorAll('button, .chip, .card-name, .fact-value, .state-title, .nav-item')]
    .filter((el) => el.offsetParent !== null && el.scrollWidth > el.clientWidth + 1)
    .map((el) => ({ text: (el.textContent ?? '').trim().slice(0, 30), scroll: el.scrollWidth, client: el.clientWidth }));
  const bodyFont = getComputedStyle(document.body).fontSize;
  // The lazy route chunks render inside Suspense — an h1 may not exist for a
  // beat; audit what is on screen instead of throwing.
  const h1 = document.querySelector('h1');
  const hindiSize = document.documentElement.lang === 'hi' && h1 ? getComputedStyle(h1).fontSize : null;
  return { lang: document.documentElement.lang, overflowX, smallTargets, truncated, bodyFont, hindiSize };
};

/** Prompt 16: the floating bar and the nav pill never overlap each other
 *  or the last content card, at 360x640 and 390x844. */
async function auditFloatOverlap(name, page) {
  for (const [width, height] of [[360, 640], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(250);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(400);
    const result = await page.evaluate(() => {
      const rect = (el) => el.getBoundingClientRect();
      const floats = [...document.querySelectorAll('[data-float], .bottom-nav')].filter((el) => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.position === 'fixed';
      });
      const cards = [...document.querySelectorAll('[data-section]')].filter(
        (el) => !['top-bar', 'nav', 'actions'].includes(el.dataset.section) && el.getBoundingClientRect().height > 0
      );
      const lastCard = cards[cards.length - 1];
      const problems = [];
      for (let i = 0; i < floats.length; i += 1) {
        for (let j = i + 1; j < floats.length; j += 1) {
          const a = rect(floats[i]);
          const b = rect(floats[j]);
          const overlap = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
          if (overlap) problems.push(`floats overlap: ${String(floats[i].className).split(' ')[0]} vs ${String(floats[j].className).split(' ')[0]}`);
        }
      }
      if (lastCard) {
        const card = rect(lastCard);
        for (const f of floats) {
          const fr = rect(f);
          const overlap = !(fr.top >= card.bottom || fr.bottom <= card.top || fr.right <= card.left || card.right <= fr.left);
          if (overlap) problems.push(`float covers last card (${lastCard.dataset.section}): ${String(f.className).split(' ')[0] || f.tagName}`);
        }
      }
      return problems;
    });
    for (const problem of result) {
      console.log(`[${name} @ ${width}x${height}] OVERLAP: ${problem}`);
    }
    if (result.length > 0) {
      return result.length;
    }
  }
  return 0;
}

async function auditPage(name, page) {
  try {
    const result = await page.evaluate(AUDIT);
    console.log(`[${name}]`, JSON.stringify(result));
  } catch (err) {
    console.error(`[${name}] AUDIT FAILED:`, err.message);
    console.error(`[${name}] url:`, page.url());
    try {
      console.error(`[${name}] body:`, (await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '));
    } catch {}
    throw err;
  }
}

async function login(page, username) {
  await page.fill('#username', username);
  await page.fill('#pin', '1234');
  await page.getByRole('button', { name: /Sign in|साइन इन/ }).click();
  // Managers land on /dashboard (SPEC 2), officers on /today.
  await page.waitForURL(/\/(today|dashboard)/, { timeout: 15000 });
  await page.waitForTimeout(400);
}

/** Drive the loan detail into every new sheet state and audit each one.
 * The Blocked sheet needs the clock OUTSIDE 08:00–19:00 IST: Playwright's
 * clock API freezes Date (16:30Z = 22:00 IST), so the skew-corrected window
 * check fails exactly as it would at night in the field. */
async function auditDetailSheets(page, lang) {
  // Outcome sheet: chips + kind toggle.
  await page.locator('button.sticky-btn-accent').click();
  await page.waitForSelector('dialog.outcome-sheet');
  await auditPage(`outcome-${lang}`, page);
  // Promise date chips (amount prefilled, validated client-side).
  await page.getByRole('button', { name: /Promise to pay|भुगतान का वादा/ }).click();
  await page.waitForTimeout(150);
  await auditPage(`outcome-promise-${lang}`, page);
  await page.getByRole('button', { name: /Cancel|रद्द करें/ }).click();

  // Save a Paid outcome: pending outbox item + 5 s Undo toast (no promise
  // side effects on the shared demo DB).
  await page.locator('button.sticky-btn-accent').click();
  await page.getByRole('button', { name: /Paid|भुगतान किया/ }).click();
  await page.getByRole('button', { name: /Save|सहेजें/ }).click();
  await page.waitForSelector('.undo-toast');
  await auditPage(`undo-${lang}`, page);
  await page.waitForSelector('.undo-toast', { state: 'detached', timeout: 8000 });

  // Blocked-by-window sheet (button looks muted but stays tappable).
  await page.clock.setFixedTime(new Date('2026-11-06T16:30:00Z'));
  await page.locator('button.sticky-btn').first().click();
  await page.waitForSelector('dialog.blocked-sheet');
  await auditPage(`blocked-${lang}`, page);
  await page.getByRole('button', { name: /Close|बंद करें/ }).click();
  await page.waitForSelector('dialog.blocked-sheet', { state: 'detached' });
  await page.clock.setFixedTime(new Date());
}

for (const lang of ['hi', 'en']) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.evaluate((l) => window.localStorage.setItem('fc.lang', l), lang);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await auditPage(`login-${lang}`, page);
  await login(page, 'demo-officer-1');
  await auditPage(`today-${lang}`, page);
  totalFindings += await auditFloatOverlap(`today-${lang}`, page);
  await page.locator('button.card').first().click();
  await page.waitForURL('**/loans/**');
  await page.waitForTimeout(400);
  await page.waitForSelector('.detail-hero', { timeout: 10000 });
  await auditPage(`detail-${lang}`, page);
  totalFindings += await auditFloatOverlap(`detail-${lang}`, page);
  await auditDetailSheets(page, lang);
  // Promises screen (prompt 11 item 5): three segments audited in place.
  // Login is demo-officer-1 (Rahul Chouhan) so every segment has content.
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Promises|वादे/ }).click();
  await page.waitForURL('**/promises', { timeout: 10000 });
  await page.waitForSelector('.segment-row', { timeout: 10000 });
  await page.waitForSelector('.promise-card, [data-testid="empty"]', { timeout: 10000 });
  await page.waitForTimeout(300);
  await auditPage(`promises-due-${lang}`, page);
  await page.getByRole('tab', { name: /Upcoming|आने वाले/ }).click();
  await page.waitForTimeout(300);
  await auditPage(`promises-upcoming-${lang}`, page);
  await page.getByRole('tab', { name: /Broken|टूटे/ }).click();
  await page.waitForTimeout(300);
  await auditPage(`promises-broken-${lang}`, page);
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Me|मेरी जानकारी/ }).click();
  await page.waitForTimeout(500);
  await auditPage(`me-${lang}`, page);
  await context.close();
}

// Manager screens (prompt 13, A67: English only) — desktop and phone, and
// the officer activity table. demo-manager is the Indore branch manager.
for (const [name, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { ...iPhoneEmulation }]]) {
  const context = await browser.newContext({ viewport: viewport.viewport ?? viewport, isMobile: viewport.isMobile ?? false, hasTouch: viewport.hasTouch ?? false, deviceScaleFactor: viewport.deviceScaleFactor ?? 1 });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.localStorage.setItem('fc.lang', 'en'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await login(page, 'demo-manager');
  await page.waitForURL('**/dashboard', { timeout: 15000 });
  await page.waitForSelector('.tile-grid', { timeout: 15000 });
  await auditPage(`manager-dashboard-${name}`, page);
  await page.locator('nav.bottom-nav').getByRole('button', { name: 'Import' }).click();
  await page.waitForURL('**/import', { timeout: 10000 });
  await page.waitForTimeout(500);
  await auditPage(`manager-import-${name}`, page);
  if (name === 'desktop') {
    await page.locator('nav.bottom-nav').getByRole('button', { name: 'Dashboard' }).click();
    await page.waitForURL('**/dashboard', { timeout: 10000 });
    await page.getByRole('button', { name: /Last 50 events/ }).first().click();
    await page.waitForURL('**/manager/officers/**', { timeout: 10000 });
    await page.waitForTimeout(600);
    await auditPage('manager-activity-desktop', page);
  }
  await context.close();
}

// The empty state is a demo product in its own right (step 0.5): demo-
// officer-3 is the territory-less joiner, so Due today shows the empty
// state with its refresh action.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.localStorage.setItem('fc.lang', 'en'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await login(page, 'demo-officer-3');
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Promises|वादे/ }).click();
  await page.waitForURL('**/promises', { timeout: 10000 });
  await page.waitForTimeout(600);
  await auditPage('promises-empty-en', page);
  await context.close();
}

await browser.close();
api.kill();
vite.kill();
if (totalFindings > 0) {
  console.error(`layout-audit FAILED: ${totalFindings} overlap finding(s)`);
  process.exit(1);
}
process.exit(0);
