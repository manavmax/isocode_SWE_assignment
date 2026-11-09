import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

/**
 * Design audit (prompts 15/21): per screen, in both languages, at 360 and
 * 412 px, verify the computed UI actually follows the redesign system —
 *   - every rendered font size is on the type scale (12/13/14/16/18/22/24/
 *     28/32/36/40/44, x1.1 when lang=hi, small browser rounding tolerance);
 *   - every padding/margin sits on the 4px scale;
 *   - only the two font weights 400 and 600;
 *   - text contrast >= 4.5:1 (>= 7:1 for body-size text >= 16px on solid
 *     backgrounds); text ON a gradient is judged against the WORST case of
 *     a 3x3 sampling grid of the mesh (prompt 21), alpha-composited, at
 *     4.5:1;
 *   - at most 3 [data-hero] gradient cards per screen;
 *   - every tap target >= 48px;
 *   - box-shadow only on [data-float], gradients only on [data-hero].
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
const vite = await start('node', ['node_modules/vite/bin/vite.js'], {}, 'Local:');

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
    const SIZES = [12, 13, 14, 16, 18, 22, 24, 28, 32, 36, 40, 44];
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
    const parseCssColor = (css) => {
      const c = css.trim();
      if (c === 'transparent') return [0, 0, 0, 0];
      if (c.startsWith('#')) {
        const hex = c.slice(1);
        if (hex.length === 3 || hex.length === 4) {
          const comps = hex.split('').map((h) => parseInt(h + h, 16));
          return [comps[0], comps[1], comps[2], comps.length === 4 ? comps[3] / 255 : 1];
        }
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return [r, g, b, hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1];
      }
      const m = c.match(/^rgba?\(([^)]+)\)$/);
      if (m) {
        const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        if (parts.length >= 3) return [parts[0], parts[1], parts[2], parts.length >= 4 ? parts[3] : 1];
      }
      return null;
    };
    const splitTop = (text) => {
      // split on commas that are not inside parens
      const out = [];
      let depth = 0;
      let cur = '';
      for (const ch of text) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) {
          out.push(cur);
          cur = '';
          continue;
        }
        cur += ch;
      }
      if (cur.trim()) out.push(cur);
      return out;
    };
    // One radial-gradient layer with explicit % radii + center — the mesh
    // recipe shape: radial-gradient(120% 90% at 0% 0%, rgb(...) 0%, rgba(0,0,0,0) 60%)
    const parseRadialLayer = (layer) => {
      const inner = layer.slice(layer.indexOf('(') + 1, layer.lastIndexOf(')'));
      const parts = splitTop(inner);
      const geo = (parts.shift() ?? '').trim().match(/^([\d.]+)%\s+([\d.]+)%\s+at\s+([\d.]+)%\s+([\d.]+)%$/);
      if (!geo) return null;
      const stops = [];
      for (const part of parts) {
        const m = part.trim().match(/^(.*?)(?:\s+([\d.]+)%)?$/s);
        if (!m) continue;
        const color = parseCssColor(m[1].trim());
        if (!color) continue;
        stops.push({ color, pos: m[2] !== undefined ? Number(m[2]) / 100 : null });
      }
      if (stops.length === 0) return null;
      if (stops[0].pos === null) stops[0].pos = 0;
      if (stops[stops.length - 1].pos === null) stops[stops.length - 1].pos = 1;
      for (let i = 1; i < stops.length - 1; i += 1) {
        if (stops[i].pos === null) {
          let j = i;
          while (stops[j].pos === null) j += 1;
          for (let k = i; k <= j; k += 1) {
            stops[k].pos = stops[i - 1].pos + ((stops[j].pos - stops[i - 1].pos) * (k - i + 1)) / (j - i + 1);
          }
        }
      }
      return { rx: Number(geo[1]) / 100, ry: Number(geo[2]) / 100, cx: Number(geo[3]) / 100, cy: Number(geo[4]) / 100, stops };
    };
    // Premultiplied interpolation between the bracketing stops at distance
    // ratio t (0 = center, 1 = the ending shape's edge), like a browser.
    const radialColorAt = (layer, t) => {
      const stops = layer.stops;
      if (t <= stops[0].pos) return stops[0].color;
      if (t >= stops[stops.length - 1].pos) return stops[stops.length - 1].color;
      let k = 0;
      while (k < stops.length - 1 && stops[k + 1].pos < t) k += 1;
      const a = stops[k];
      const b = stops[k + 1];
      const u = (t - a.pos) / (b.pos - a.pos);
      const alpha = a.color[3] * (1 - u) + b.color[3] * u;
      if (alpha <= 0) return [0, 0, 0, 0];
      return [
        (a.color[0] * a.color[3] * (1 - u) + b.color[0] * b.color[3] * u) / alpha,
        (a.color[1] * a.color[3] * (1 - u) + b.color[1] * b.color[3] * u) / alpha,
        (a.color[2] * a.color[3] * (1 - u) + b.color[2] * b.color[3] * u) / alpha,
        alpha
      ];
    };
    // Composite the mesh layers (bottom-first) over the solid base at one
    // fraction point of the element box.
    const meshColorAt = (layers, base, fx, fy) => {
      let out = base;
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const layer = layers[i];
        const dx = (fx - layer.cx) / layer.rx;
        const dy = (fy - layer.cy) / layer.ry;
        const t = Math.sqrt(dx * dx + dy * dy);
        const color = radialColorAt(layer, t);
        out = [
          color[0] * color[3] + out[0] * (1 - color[3]),
          color[1] * color[3] + out[1] * (1 - color[3]),
          color[2] * color[3] + out[2] * (1 - color[3]),
          1
        ];
      }
      return out;
    };
    const ratioRgb = (fgArr, bgArr) => {
      const lin = (v) => {
        const c = Math.min(Math.max(v / 255, 0), 1);
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const l = (arr) => 0.2126 * lin(arr[0]) + 0.7152 * lin(arr[1]) + 0.0722 * lin(arr[2]);
      const l1 = l(fgArr);
      const l2 = l(bgArr);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
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
      const tag = el.tagName.toLowerCase() + '.' + (typeof el.className === 'string' ? el.className : String(el.className?.baseVal ?? '')).split(' ')[0];
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
          gradientBg = image; // text on a gradient: worst case of a 3x3 mesh sample (prompt 21)
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
      const fg = parseCssColor(style.color) ?? [0, 0, 0, 1];
      let ratio;
      let onLabel = bg;
      if (gradientBg) {
        // Sample the mesh at a 3x3 grid, alpha-composite the text colour over
        // every sample, judge the WORST case. Prompt 21: 4.5:1 on gradients.
        const base = parseCssColor(getComputedStyle(bgEl).backgroundColor) ?? [255, 255, 255, 1];
        const layers = splitTop(gradientBg).map(parseRadialLayer).filter(Boolean);
        ratio = Infinity;
        for (const fx of [0.15, 0.5, 0.85]) {
          for (const fy of [0.15, 0.5, 0.85]) {
            const sample = layers.length ? meshColorAt(layers, base, fx, fy) : base;
            const eff = [
              fg[0] * fg[3] + sample[0] * (1 - fg[3]),
              fg[1] * fg[3] + sample[1] * (1 - fg[3]),
              fg[2] * fg[3] + sample[2] * (1 - fg[3]),
              1
            ];
            ratio = Math.min(ratio, ratioRgb(eff, sample));
          }
        }
        onLabel = layers.length ? 'mesh 3x3 worst' : 'gradient';
      } else {
        const bgForContrast = bg === 'rgba(0, 0, 0, 0)' ? 'rgb(255, 255, 255)' : bg;
        ratio = contrast(style.color, bgForContrast);
      }
      const bodySize = size >= 16 && weight < 600;
      const threshold = gradientBg ? 4.5 : bodySize ? 7 : 4.5;
      if (ratio < threshold) {
        findings.push('contrast ' + ratio.toFixed(2) + ':1 < ' + threshold + ':1 on ' + tag + ' (' + style.color + ' on ' + onLabel + ')');
      }
    }
    const heroCount = document.querySelectorAll('[data-hero]').length;
    if (heroCount > 3) {
      findings.push(heroCount + ' [data-hero] gradient cards on one screen (max 3)');
    }
    for (const el of [...document.querySelectorAll('body *')]) {
      if (getComputedStyle(el).display === 'none') continue;
      const style = getComputedStyle(el);
      const tag = el.tagName.toLowerCase() + '.' + (typeof el.className === 'string' ? el.className : String(el.className?.baseVal ?? '')).split(' ')[0];
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
// prompt 21: run every phone screen at both 360 and 412 px, en and hi.
for (const lang of ['en', 'hi']) {
  for (const width of [360, 412]) {
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.evaluate((l) => window.localStorage.setItem('fc.lang', l), lang);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  totalFindings += await auditPage(`login-${width}-${lang}`, page);
  await login(page, 'demo-officer-1');
  await page.waitForSelector('button.card, [data-testid="empty"], [data-testid="error"]', { timeout: 60000 });
  totalFindings += await auditPage(`today-${width}-${lang}`, page);
  totalFindings += await assertOrder(`today-${width}-${lang}`, page, 'today');
  await page.locator('button.card').first().click({ timeout: 60000 });
  await page.waitForURL('**/loans/**');
  await page.waitForSelector('.detail-hero', { timeout: 10000 });
  await page.waitForTimeout(300);
  totalFindings += await auditPage(`detail-${width}-${lang}`, page);
  totalFindings += await assertOrder(`detail-${width}-${lang}`, page, 'detail');
  await page.locator('button.sticky-btn-accent').click();
  await page.waitForSelector('dialog.outcome-sheet');
  await page.waitForTimeout(200);
  totalFindings += await auditPage(`outcome-sheet-${width}-${lang}`, page);
  await page.getByRole('button', { name: /Cancel|रद्द करें/ }).click();
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Promises|वादे/ }).click();
  await page.waitForURL('**/promises');
  await page.waitForTimeout(500);
  totalFindings += await auditPage(`promises-${width}-${lang}`, page);
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Me|मेरी जानकारी/ }).click();
  await page.waitForTimeout(400);
  totalFindings += await auditPage(`me-${width}-${lang}`, page);
  await context.close();
  }
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
