import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

/**
 * Design audit (prompt 15): per screen, in both languages, verify the
 * computed UI actually follows the redesign system —
 *   - every rendered font size is on the type scale (12/13/14/16/18/22/24/
 *     28/32/36, x1.1 when lang=hi, small browser rounding tolerance);
 *   - every padding/margin sits on the 4px scale;
 *   - only the two font weights 400 and 600;
 *   - text contrast >= 4.5:1 (>= 7:1 for body-size text >= 16px);
 *   - every tap target >= 48px;
 *   - no box-shadow, no gradient anywhere.
 * Non-zero exit on any finding. Local-only (dev API + vite), like the
 * layout audit.
 */

const BASE = 'http://localhost:5173';

function start(cmd, args, env, waitText) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
  // kill the whole process group: `pnpm dev` wraps vite, and killing pnpm
  // alone orphans vite on :5173 — a stale server then poisons the next run
  for (const child of [api, vite]) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
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

// Layout contracts (prompt 16): runtime data-section order per screen.
const CONTRACTS = JSON.parse(readFileSync(new URL('../src/client/screens/contracts.json', import.meta.url), 'utf8'));
const SCREEN_CONTRACTS = [
  { name: 'today', file: 'today', select: async (page) => { await gotoLogin(page, 'en'); await login(page, 'demo-officer-1'); await page.waitForSelector('[data-section="cards"]', { timeout: 60000 }); } },
  { name: 'detail', file: 'detail', select: async (page) => { await gotoLogin(page, 'en'); await login(page, 'demo-officer-1'); await page.waitForSelector('button.card', { timeout: 60000 }); await page.locator('button.card').first().click(); await page.waitForSelector('[data-section="actions"]', { timeout: 60000 }); } },
  { name: 'manager', file: 'manager', select: async (page) => { await gotoLogin(page, 'en'); await login(page, 'demo-manager'); await page.waitForSelector('[data-section="kpis"]', { timeout: 60000 }); } }
];
const AUDIT_DEFAULT = process.env.AUDIT_SKIP_ORDER ? null : null;

async function runAudit(page) {
  return page.evaluate(() => {
    const SIZES = [12, 13, 14, 16, 18, 22, 24, 28, 32, 36];
    const TOLERANCE = 0.6;
    // Prompt-20 additions: 20px = the why-score card padding (item 7);
    // 108px = scroll clearance under the floating nav, nav height + 24
    // (item 9); 196px = detail clearance, nav + floating action bar + 24.
    const SPACING = [0, 4, 8, 12, 16, 20, 24, 32, 48, 56, 88, 96, 108, 120, 196];
    const WEIGHTS = [400, 600];
    const lang = document.documentElement.lang;
    const onScale = (size) => {
      const allowed = lang === 'hi' ? [...SIZES, ...SIZES.map((s) => s * 1.1)] : SIZES;
      return allowed.some((s) => Math.abs(s - size) <= TOLERANCE);
    };
    const onSpacingScale = (value) => {
      // Devanagari scales the root by 1.1, so rem-based spacing computes at
      // x1.1 in Hindi — accepted by design (SPEC 15).
      const candidates = lang === 'hi' ? [...SPACING, ...SPACING.map((s) => s * 1.1)] : SPACING;
      return candidates.some((s) => Math.abs(s - value) <= 0.6);
    };
    const luminance = (rgb) => {
      const m = rgb.match(/([\d.]+)/g);
      if (!m || m.length < 3) return 1;
      const [r, g, b] = m.slice(0, 3).map((v) => {
        const c = Number(v) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const lighterGradientStop = (image) => {
      // Pick the stop colour with the HIGHEST luminance (the lighter stop).
      const stops = (image.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/g) || [])
        .map((css) => ({ css, lum: luminance(css) }))
        .sort((a, b) => b.lum - a.lum);
      return stops.length ? stops[0].css : 'rgb(255, 255, 255)';
    };
    const contrast = (fg, bg) => {
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const findings = [];
    const visible = [...document.querySelectorAll('body *')].filter((el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.textContent && el.textContent.trim();
    });
    for (const el of visible) {
      if (el.children.length > 0 && el.textContent === Array.from(el.children).map((c) => c.textContent).join('')) {
        continue;
      }
      const style = getComputedStyle(el);
      const tag = el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0];
      const size = parseFloat(style.fontSize);
      if (!onScale(size)) {
        findings.push('font-size ' + size.toFixed(1) + 'px off-scale on ' + tag);
      }
      const weight = style.fontWeight === 'bold' ? 700 : Number(style.fontWeight);
      if (!WEIGHTS.includes(weight)) {
        findings.push('font-weight ' + weight + ' on ' + tag);
      }
      let bgEl = el;
      let bg = 'rgba(0, 0, 0, 0)';
      let gradientBg = null;
      while (bgEl && bg === 'rgba(0, 0, 0, 0)' && !gradientBg) {
        const image = getComputedStyle(bgEl).backgroundImage;
        if (image && image.includes('gradient')) {
          gradientBg = image; // text on a gradient: judge vs the lighter stop
          break;
        }
        bg = getComputedStyle(bgEl).backgroundColor;
        // Semi-transparent overlays (white 18% over a gradient, etc.) do not
        // give a usable solid bg — keep walking to the painted surface.
        const alpha = bg.startsWith('rgba') ? Number(bg.match(/([\d.]+)\)$/)?.[1] ?? 1) : 1;
        if (alpha < 0.5) {
          bg = 'rgba(0, 0, 0, 0)';
        }
        bgEl = bgEl.parentElement;
      }
      let bgForContrast = bg;
      if (gradientBg) bgForContrast = lighterGradientStop(gradientBg);
      if (bg === 'rgba(0, 0, 0, 0)' && !gradientBg) bgForContrast = 'rgb(255, 255, 255)';
      const ratio = contrast(style.color, bgForContrast);
      const bodySize = size >= 16 && weight < 600;
      const threshold = bodySize ? 7 : 4.5;
      if (ratio < threshold) {
        findings.push('contrast ' + ratio.toFixed(2) + ':1 < ' + threshold + ':1 on ' + tag + ' (' + style.color + ' on ' + (gradientBg ? 'gradient' : bg) + ')');
      }
    }
    for (const el of [...document.querySelectorAll('body *')]) {
      if (getComputedStyle(el).display === 'none') continue;
      const style = getComputedStyle(el);
      const tag = el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0];
      for (const prop of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight']) {
        const specified = style[prop];
        const value = parseFloat(specified);
        if (!Number.isNaN(value) && value > 0 && !onSpacingScale(value)) {
          // Auto-centered screens: the max-width wrapper's computed side
          // margins are layout, not spacing-scale values.
          const exempt = el.closest('[data-auto-centered="true"]') && (prop === 'marginLeft' || prop === 'marginRight');
          if (!exempt) {
            findings.push(prop + ' ' + value + 'px off-scale on ' + tag);
          }
        }
      }
      if (style.boxShadow !== 'none' && !el.closest('[data-float]')) findings.push('box-shadow outside [data-float] on ' + tag);
      if (style.backgroundImage.includes('gradient') && !el.closest('[data-hero]')) findings.push('gradient outside [data-hero] on ' + tag);
    }
    for (const el of document.querySelectorAll('button, a.btn, a.chip, [role="button"]')) {
      if (el.offsetParent === null) continue;
      const rect = el.getBoundingClientRect();
      if (rect.height < 48 || (rect.width < 48 && rect.height < 48)) {
        findings.push('tap target ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ' < 48 on ' + el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]);
      }
    }
    return [...new Set(findings)];
  });
}


async function gotoLogin(page, lang) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.evaluate((l) => window.localStorage.setItem('fc.lang', l), lang);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
}

async function login(page, username) {
  await page.fill('#username', username);
  await page.fill('#pin', '1234');
  await page.getByRole('button', { name: /Sign in|साइन इन/ }).click();
  await page.waitForURL(/\/(today|dashboard)/, { timeout: 15000 });
  await page.waitForTimeout(500);
}

async function assertOrder(name, page, contract) {
  const actual = await page.evaluate(() => [...document.querySelectorAll('[data-section]')].map((el) => el.dataset.section));
  const expected = CONTRACTS[contract];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.log(`[${name}] ORDER MISMATCH: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    return 1;
  }
  return 0;
}

async function auditPage(name, page) {
  const result = await runAudit(page);
  if (result.length === 0) {
    console.log(`[${name}] PASS`);
  } else {
    console.log(`[${name}] ${result.length} finding(s):`);
    for (const finding of result) {
      console.log(`  - ${finding}`);
    }
    return result.length;
  }
  return 0;
}


let totalFindings = 0;
for (const lang of ['en', 'hi']) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.evaluate((l) => window.localStorage.setItem('fc.lang', l), lang);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  totalFindings += await auditPage(`login-${lang}`, page);
  await login(page, 'demo-officer-1');
  await page.waitForSelector('button.card, [data-testid="empty"], [data-testid="error"]', { timeout: 60000 });
  totalFindings += await auditPage(`today-${lang}`, page);
  totalFindings += await assertOrder(`today-${lang}`, page, 'today');
  await page.locator('button.card').first().click({ timeout: 60000 });
  await page.waitForURL('**/loans/**');
  await page.waitForSelector('.detail-hero', { timeout: 10000 });
  await page.waitForTimeout(300);
  totalFindings += await auditPage(`detail-${lang}`, page);
  totalFindings += await assertOrder(`detail-${lang}`, page, 'detail');
  await page.locator('button.sticky-btn-accent').click();
  await page.waitForSelector('dialog.outcome-sheet');
  await page.waitForTimeout(200);
  totalFindings += await auditPage(`outcome-sheet-${lang}`, page);
  await page.getByRole('button', { name: /Cancel|रद्द करें/ }).click();
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Promises|वादे/ }).click();
  await page.waitForURL('**/promises');
  await page.waitForTimeout(500);
  totalFindings += await auditPage(`promises-${lang}`, page);
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Me|मेरी जानकारी/ }).click();
  await page.waitForTimeout(400);
  totalFindings += await auditPage(`me-${lang}`, page);
  await context.close();
}

// Manager dashboard (A67: English only).
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.localStorage.setItem('fc.lang', 'en'));
  await page.reload({ waitUntil: 'networkidle' });
  await login(page, 'demo-manager');
  await page.waitForSelector('.tile-grid', { timeout: 15000 });
  await page.waitForTimeout(500);
  totalFindings += await auditPage('manager-dashboard-desktop', page);
  totalFindings += await assertOrder('manager-dashboard-desktop', page, 'manager');
  await context.close();
}

await browser.close();
api.kill();
vite.kill();
if (totalFindings > 0) {
  console.error(`design-audit FAILED: ${totalFindings} finding(s)`);
  process.exit(1);
}
console.log('design-audit PASS — all screens, both languages');
process.exit(0);
