import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium, devices } from '@playwright/test';

/**
 * Mobile correctness check (prompt 18): real device emulation — isMobile,
 * hasTouch, deviceScaleFactor 3 — across iPhone 13, Pixel 7 and a small
 * Android. For Today, loan detail, outcome sheet, promises, me and login:
 *   - no horizontal scroll (documentElement.scrollWidth <= innerWidth);
 *   - visualViewport.scale === 1;
 *   - the floating nav / detail action bar: left >= 8, right <= vw - 8,
 *     horizontally centred within 2px;
 *   - the bar does not overlap the last card (scroll to bottom first);
 *   - no element wider than the viewport.
 * Screenshots land in docs/screens/mobile/<device>-<screen>.png.
 * Local-only: starts the dev API + vite itself.
 */

const BASE = 'http://localhost:5173';
const OUT = 'docs/screens/mobile';
mkdirSync(OUT, { recursive: true });

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

const DEVICE_LIST = [
  ['iphone13', { ...devices['iPhone 13'], deviceScaleFactor: 3 }],
  ['pixel7', { ...devices['Pixel 7'], deviceScaleFactor: 3 }],
  ['small-android', { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (Linux; Android 13; sm-a037f) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' }]
];

const SCREENS = ['login', 'today', 'detail', 'outcome-sheet', 'promises', 'me'];

let totalFailures = 0;
const browser = await chromium.launch();

async function auditScreen(page, screen, deviceName) {
  const failures = [];
  const vw = await page.evaluate(() => window.innerWidth);
  const vh = await page.evaluate(() => window.innerHeight);

  // 1. no horizontal scroll
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  if (scrollWidth > vw) {
    failures.push(`horizontal scroll: scrollWidth ${scrollWidth} > innerWidth ${vw}`);
  }

  // 2. visual viewport scale 1
  const scale = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  if (Math.abs(scale - 1) > 0.01) {
    failures.push(`visualViewport.scale ${scale} !== 1`);
  }

  // 3. floating chrome geometry
  const floats = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.bottom-nav, .sticky-bar')) {
      const style = getComputedStyle(el);
      if (style.display === 'none') continue;
      const rect = el.getBoundingClientRect();
      out.push({
        name: el.className.split(' ')[0] || el.tagName,
        left: rect.left,
        right: window.innerWidth - rect.right,
        centreOffset: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2)
      });
    }
    return out;
  });
  for (const f of floats) {
    if (f.left < 8) failures.push(`${f.name} left ${f.left.toFixed(1)} < 8`);
    if (f.right < 8) failures.push(`${f.name} right ${f.right.toFixed(1)} < 8`);
    if (f.centreOffset > 2) failures.push(`${f.name} off-centre by ${f.centreOffset.toFixed(1)}px`);
  }

  // 4. scroll to the bottom; the last card must clear the floating chrome
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(500);
  const overlap = await page.evaluate(() => {
    const floats = [...document.querySelectorAll('.bottom-nav, .sticky-bar')].map((el) => el.getBoundingClientRect());
    const sections = [...document.querySelectorAll('[data-section]')].filter(
      (el) =>
        !['top-bar', 'nav', 'actions'].includes(el.dataset.section) &&
        el.getBoundingClientRect().height > 0 &&
        !el.closest('dialog') // modal content owns the bottom while open
    );
    const last = sections[sections.length - 1];
    if (!last) return null;
    const card = last.getBoundingClientRect();
    const debug = { last: last.dataset.section, cardBottom: Math.round(card.bottom), floats: floats.map((r) => ({ top: Math.round(r.top), bottom: Math.round(r.bottom) })) };
    for (const fr of floats) {
      const overlapY = !(fr.top >= card.bottom || fr.bottom <= card.top);
      const overlapX = !(fr.right <= card.left || card.right <= fr.left);
      if (overlapY && overlapX) {
        return JSON.stringify(debug);
      }
    }
    return null;
  });
  if (overlap) failures.push(overlap);

  // 5. no element wider than the viewport
  const wide = await page.evaluate((vwInner) => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.position === 'fixed') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > vwInner + 1) {
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(rect.width)}px`);
      }
    }
    return out;
  }, vw);
  for (const w of wide) failures.push(`element wider than viewport: ${w}`);

  // 6. icon buttons render a real inline SVG icon; back buttons keep 16px
  // from the left edge (prompt 20 item 4)
  const icons = await page.evaluate(() => {
    const out = [];
    for (const btn of document.querySelectorAll('button.icon-button')) {
      const svg = btn.querySelector('svg');
      const box = svg ? svg.getBoundingClientRect() : null;
      out.push({
        label: btn.getAttribute('aria-label') ?? '',
        hasSvg: Boolean(svg),
        w: Math.round(box?.width ?? 0),
        h: Math.round(box?.height ?? 0),
        left: btn.getBoundingClientRect().left
      });
    }
    return out;
  });
  for (const icon of icons) {
    if (!icon.hasSvg || icon.w <= 0 || icon.h <= 0) {
      failures.push(`icon-button "${icon.label}" has no visible inline svg`);
    }
    if (/back|वापस/i.test(icon.label) && icon.left < 16) {
      failures.push(`back button ${icon.left.toFixed(1)}px from left edge < 16px`);
    }
  }

  // 7. floating action bar circles: 56px, #2a3038 fill, 24px icon (prompt 20 item 8)
  const circle = await page.evaluate(() => {
    const btn = document.querySelector('.sticky-bar .sticky-btn:not(.sticky-btn-accent)');
    if (!btn) return null;
    const rect = btn.getBoundingClientRect();
    const style = getComputedStyle(btn);
    const svgBox = btn.querySelector('svg')?.getBoundingClientRect();
    return { w: rect.width, h: rect.height, bg: style.backgroundColor, iconW: svgBox?.width ?? 0 };
  });
  if (circle) {
    if (Math.round(circle.w) !== 56 || Math.round(circle.h) !== 56) {
      failures.push(`action circle ${Math.round(circle.w)}x${Math.round(circle.h)} != 56x56`);
    }
    if (circle.bg !== 'rgb(42, 48, 56)') failures.push(`action circle fill ${circle.bg} != rgb(42, 48, 56)`);
    if (circle.iconW < 23) failures.push(`action icon ${Math.round(circle.iconW)}px < 24px`);
  }

  // 8. shell bottom (prompt 20 item 9): page grey to the bottom, nothing
  // paints below the floating nav, no control covered by the floating
  // chrome at scroll end (the viewport is scrolled to the end by check 4)
  const shell = await page.evaluate(() => {
    const nav = document.querySelector('.bottom-nav');
    const navRect = nav?.getBoundingClientRect();
    const band = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.height === 0 || getComputedStyle(el).position === 'fixed') continue;
      if (navRect && rect.top >= navRect.top - 2 && !nav.contains(el) && el !== nav) {
        band.push(el.tagName.toLowerCase());
      }
    }
    const floats = [...document.querySelectorAll('.bottom-nav, .sticky-bar')].map((el) => el.getBoundingClientRect());
    const covered = [];
    for (const el of document.querySelectorAll('main button, main a, main input, main select')) {
      const rect = el.getBoundingClientRect();
      if (rect.height === 0 || el.closest('dialog')) continue;
      for (const fr of floats) {
        const overlapY = !(rect.bottom <= fr.top || rect.top >= fr.bottom);
        const overlapX = !(rect.right <= fr.left || rect.left >= fr.right);
        if (overlapY && overlapX) covered.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
      }
    }
    return {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      band: band.slice(0, 4),
      covered: covered.slice(0, 4)
    };
  });
  if (shell.bodyBg !== 'rgb(238, 240, 243)') failures.push(`body background ${shell.bodyBg} is not the page grey`);
  for (const b of shell.band) failures.push(`element paints below the floating nav: ${b}`);
  for (const c of shell.covered) failures.push(`floating chrome covers a control at scroll end: ${c}`);

  // 9. nothing clips inside a card (prompt 20 item 6)
  const clipped = await page.evaluate(() => {
    const out = [];
    const containers = document.querySelectorAll('.card, .tile, .manager-table tr');
    for (const el of containers) {
      const check = (node) => {
        if (node.scrollWidth > node.clientWidth + 1) {
          out.push(`${String(el.className).split(' ')[0]} > ${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]} ${node.scrollWidth}>${node.clientWidth}`);
        }
      };
      check(el);
      for (const child of el.querySelectorAll('*')) check(child);
    }
    return out.slice(0, 4);
  });
  for (const c of clipped) failures.push(`card content clipped: ${c}`);

  const shot = `${OUT}/${deviceName}-${screen}.png`;
  await page.screenshot({ path: shot, fullPage: false });

  if (failures.length === 0) {
    console.log(`[${deviceName}/${screen}] PASS`);
  } else {
    console.log(`[${deviceName}/${screen}] ${failures.length} finding(s):`);
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }
    totalFailures += failures.length;
  }
  writeFileSync(`${OUT}/${deviceName}-${screen}.json`, JSON.stringify({ device: deviceName, screen, viewport: { vw, vh }, failures }, null, 2));
}

async function gotoLogin(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
}

for (const [deviceName, device] of DEVICE_LIST) {
  const context = await browser.newContext({ ...device });
  const page = await context.newPage();

  // login
  await gotoLogin(page);
  await page.fill('#username', 'demo-officer-1');
  await page.fill('#pin', '1234');
  await page.getByRole('button', { name: /Sign in|साइन इन/ }).click();
  await page.waitForURL(/\/(today|dashboard)/, { timeout: 30000 });
  await page.waitForSelector('button.card, [data-testid="error"], [data-testid="empty"]', { timeout: 60000 });
  await page.waitForTimeout(400);
  await auditScreen(page, 'today', deviceName);

  // loan detail + outcome sheet
  await page.locator('button.card').first().click();
  await page.waitForSelector('[data-section="actions"]', { timeout: 60000 });
  await page.waitForTimeout(300);
  await auditScreen(page, 'detail', deviceName);
  await page.locator('button.sticky-btn-accent').click();
  await page.waitForSelector('dialog.outcome-sheet');
  await page.waitForTimeout(300);
  await auditScreen(page, 'outcome-sheet', deviceName);
  await page.getByRole('button', { name: /Cancel|रद्द करें/ }).click();

  // promises + me
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Promises|वादे/ }).click();
  await page.waitForTimeout(600);
  await auditScreen(page, 'promises', deviceName);
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Me|मेरी जानकारी/ }).click();
  await page.waitForTimeout(500);
  await auditScreen(page, 'me', deviceName);

  // login screen (fresh context behaviour: logout and look again)
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Me|मेरी जानकारी/ }).click();
  await page.getByRole('button', { name: /Log out|लॉग आउट/ }).first().click();
  await page.waitForURL('**/login', { timeout: 15000 });
  await page.waitForTimeout(300);
  await auditScreen(page, 'login', deviceName);

  await context.close();
}

// Manager screens (English-only, A67): dashboard, activity (via the tile —
// resolves the 'first' sentinel), import. Same audit rules apply.
for (const [deviceName, device] of DEVICE_LIST) {
  const context = await browser.newContext({ ...device });
  const page = await context.newPage();

  await gotoLogin(page);
  await page.fill('#username', 'demo-manager');
  await page.fill('#pin', '1234');
  await page.getByRole('button', { name: /Sign in|साइन इन/ }).click();
  await page.waitForURL('**/dashboard', { timeout: 30000 });
  await page.waitForSelector('.manager-table', { timeout: 60000 });
  await page.waitForTimeout(400);
  await auditScreen(page, 'dashboard', deviceName);

  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.waitForTimeout(1200);
  await auditScreen(page, 'activity', deviceName);

  await page.locator('nav.bottom-nav').getByRole('button', { name: 'Import' }).click();
  await page.waitForTimeout(800);
  await auditScreen(page, 'import', deviceName);

  await context.close();
}

await browser.close();
cleanup();
if (totalFailures > 0) {
  console.error(`mobile-check FAILED: ${totalFailures} finding(s)`);
  process.exit(1);
}
console.log('mobile-check PASS — all devices, all screens');
process.exit(0);
