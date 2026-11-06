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
const browser = await chromium.launch();

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
  const hindiSize = document.documentElement.lang === 'hi' ? getComputedStyle(document.querySelector('h1')).fontSize : null;
  return { lang: document.documentElement.lang, overflowX, smallTargets, truncated, bodyFont, hindiSize };
};

async function auditPage(name, page) {
  const result = await page.evaluate(AUDIT);
  console.log(`[${name}]`, JSON.stringify(result));
}

async function login(page, username) {
  await page.fill('#username', username);
  await page.fill('#pin', '1234');
  await page.getByRole('button', { name: /Sign in|साइन इन/ }).click();
  await page.waitForURL('**/today', { timeout: 15000 });
  await page.waitForTimeout(400);
}

for (const lang of ['hi', 'en']) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.evaluate((l) => window.localStorage.setItem('fc.lang', l), lang);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await auditPage(`login-${lang}`, page);
  await login(page, 'arjun.verma');
  await auditPage(`today-${lang}`, page);
  await page.locator('button.card').first().click();
  await page.waitForURL('**/loans/**');
  await page.waitForTimeout(400);
  await auditPage(`detail-${lang}`, page);
  await page.getByRole('button', { name: /Me|मेरी जानकारी/ }).click();
  await page.waitForTimeout(300);
  await auditPage(`me-${lang}`, page);
  await context.close();
}

await browser.close();
api.kill();
vite.kill();
process.exit(0);
