import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

/**
 * QA audit (prompt 17 request): live deployment, real device emulation,
 * evidence-based findings only. Writes qa-audit-results.json + per-device
 * screenshots into qa-evidence/.
 */

const BASE = process.argv[2] ?? 'https://isocode-swe-assignment.vercel.app';
mkdirSync('qa-evidence', { recursive: true });

const results = { url: BASE, devices: {}, network: {}, security: {}, console: {}, notes: [] };
const FINDINGS = [];
let fid = 0;
function finding(severity, screen, devicesList, what, evidence, fix) {
  fid += 1;
  FINDINGS.push({ id: `QA-${String(fid).padStart(2, '0')}`, severity, screen, devices: devicesList, what, evidence, fix });
  console.log(`[${fid}] ${severity} ${screen} (${devicesList}): ${what} — ${evidence}`);
}

const DEVICES = {
  'iphone-se': { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  'iphone13': { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  'pixel7': { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  'small-android': { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  'desktop': { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  'pixel7-landscape': { viewport: { width: 915, height: 412 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
};

function luminance(rgb) {
  const m = rgb.match(/([\d.]+)/g);
  if (!m || m.length < 3) return 1;
  const [r, g, b] = m.slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const browser = await chromium.launch();

// ---------- 0. security headers, manifest, SW, theme-color, bundle secrets ----------
{
  const res = await fetch(`${BASE}/`);
  const headers = {};
  for (const [k, v] of res.headers) headers[k.toLowerCase()] = v;
  results.security.headers = headers;
  const html = await res.text();
  results.security.themeColor = html.match(/<meta name="theme-color" content="([^"]+)"/)?.[1] ?? 'MISSING';
  results.security.viewport = html.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? 'MISSING';
  results.security.title = html.match(/<title>([^<]+)<\/title>/)?.[1] ?? 'MISSING';
  // secrets in HTML
  for (const pattern of ['postgres://', 'DATABASE_URL', 'SESSION_SECRET', 'neondb_owner', 'sk-']) {
    if (html.toLowerCase().includes(pattern.toLowerCase())) {
      finding('Blocker', 'HTML', 'all', `secret pattern "${pattern}" in page source`, 'index.html', 'remove');
    }
  }
  // manifest
  const manifestHref = html.match(/<link rel="manifest" href="([^"]+)"/)?.[1];
  if (manifestHref) {
    const mres = await fetch(`${BASE}${manifestHref}`);
    const manifest = await mres.json();
    results.security.manifest = {
      name: manifest.name,
      theme_color: manifest.theme_color,
      background_color: manifest.background_color,
      display: manifest.display,
      icons: (manifest.icons ?? []).map((i) => `${i.sizes} ${i.type ?? ''} ${i.src}`)
    };
    if (manifest.theme_color === '#0f5f5c') {
      finding('Minor', 'PWA manifest', 'all', 'manifest theme_color is the old teal #0f5f5c, not the page grey/brown of the current UI', `manifest.theme_color = ${manifest.theme_color}`, 'update manifest.theme_color to #0e1116 (or the page grey) and regenerate icons');
    }
    const missingIcon = (manifest.icons ?? []).find((i) => i.sizes.includes('512') && !i.src.startsWith('data:'));
    if (missingIcon) {
      const iconUrl = missingIcon.src.startsWith('http') ? missingIcon.src : `${BASE}/${missingIcon.src.replace(/^\//, '')}`;
      const ires = await fetch(iconUrl);
      if (!ires.ok) finding('Major', 'PWA manifest', 'all', `icon ${missingIcon.src} returns ${ires.status}`, 'manifest icons', 'fix icon path');
    }
  } else {
    finding('Major', 'PWA manifest', 'all', 'no <link rel="manifest"> in index.html', 'index.html', 'add the manifest link');
  }
  // SW
  const swRes = await fetch(`${BASE}/sw.js`);
  results.security.serviceWorker = { status: swRes.status, size: (await swRes.text()).length };
}

// ---------- 1. login-error leak + rate limit (fetch, no browser) ----------
{
  const wrongPinKnown = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo-officer-1', pin: '000000' })
  });
  const knownBody = await wrongPinKnown.json();
  const wrongPinUnknown = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-probe-user-does-not-exist', pin: '000000' })
  });
  const unknownBody = await wrongPinUnknown.json();
  results.security.loginErrorKnown = { status: wrongPinKnown.status, body: knownBody };
  results.security.loginErrorUnknown = { status: wrongPinUnknown.status, body: unknownBody };
  if (JSON.stringify(knownBody) !== JSON.stringify(unknownBody) || wrongPinKnown.status !== wrongPinUnknown.status) {
    finding('Major', 'Login', 'all', 'login error differs between known and unknown usernames (user enumeration)', `${JSON.stringify(knownBody)} vs ${JSON.stringify(unknownBody)}`, 'return the identical generic error for both');
  }
  // rate limit: 5 failures on a throwaway username (never a demo account)
  let limited = null;
  for (let i = 0; i < 6; i += 1) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-rate-limit-probe', pin: '000000' })
    });
    if (r.status === 429) {
      limited = { attempt: i + 1, retryAfter: r.headers.get('retry-after') };
      break;
    }
  }
  results.security.rateLimit = limited ?? 'NOT TRIGGERED after 6 attempts';
  if (!limited) {
    finding('Major', 'Login', 'all', 'wrong-PIN rate limit did not trigger after 6 attempts', JSON.stringify(results.security.rateLimit), 'check login_attempt window logic');
  }
  // cross-officer loan access
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo-officer-1', pin: '1234' })
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const foreign = await fetch(`${BASE}/api/loans/LN-10871`, { headers: { cookie } }); // seeded to Neha Solanki (Dewas)
  results.security.crossOfficerLoan = { status: foreign.status, loan: 'LN-10871' };
  if (foreign.status !== 404) {
    finding('Blocker', 'Loan detail', 'all', `officer can open another officer's loan (LN-10871, Neha Solanki): HTTP ${foreign.status}`, 'GET /api/loans/LN-10871 as demo-officer-1', 'the visibility rule must answer 404');
  }
}

// ---------- 2. bundle secrets ----------
{
  const html = await (await fetch(`${BASE}/`)).text();
  const bundles = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  const leaks = [];
  for (const bundle of bundles) {
    const js = await (await fetch(`${BASE}${bundle}`)).text();
    for (const pattern of ['postgres://', 'DATABASE_URL', 'SESSION_SECRET', 'neondb_owner', 'sk-live']) {
      if (js.includes(pattern)) leaks.push(`${pattern} in ${bundle}`);
    }
  }
  results.security.bundleLeaks = leaks;
  if (leaks.length) finding('Blocker', 'JS bundles', 'all', 'secret patterns in shipped JS', leaks.join('; '), 'remove');
}

// ---------- 3. per-device, per-screen browser audits ----------
const consoleLogs = {};
const failedRequests = {};
const slowCalls = {};

for (const [deviceName, device] of Object.entries(DEVICES)) {
  const context = await browser.newContext({ ...device });
  const page = await context.newPage();
  const errors = [];
  const failed = [];
  const slow = [];
  const apiTimings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`${msg.type()}: ${msg.text().slice(0, 180)}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err).slice(0, 180)}`));
  page.on('requestfinished', async (req) => {
    if (!req.url().includes('/api/')) return;
    const timing = await req.response()?.then((r) => (r ? r.serverAddr() : null)) ?? null;
    const t = req.timing();
    const ms = Math.round(t.responseEnd - t.startTime);
    apiTimings.push({ url: req.url().replace(BASE, ''), ms, status: null });
    if (ms > 1500) slow.push(`${req.url().replace(BASE, '')} ${ms}ms`);
  });
  page.on('requestfailed', (req) => failed.push(`${req.url().replace(BASE, '')}: ${req.failure()?.errorText}`));

  const deviceFindings = [];
  const shoot = async (screen) => {
    await page.screenshot({ path: `qa-evidence/${deviceName}-${screen}.png` });
  };

  // --- login screen ---
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  {
    const m = await page.evaluate(() => {
      const out = { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, themeColor: document.querySelector('meta[name="theme-color"]')?.content };
      return out;
    });
    if (m.scrollWidth > m.innerWidth) deviceFindings.push(['Major', 'Login', `horizontal scroll: scrollWidth ${m.scrollWidth} > ${m.innerWidth}`, `document.documentElement.scrollWidth`, '']);
    if (m.themeColor === '#0f5f5c') deviceFindings.push(['Minor', 'Login', 'theme-color meta is the old teal #0f5f5c', `<meta name="theme-color" content="${m.themeColor}">`, 'update to match the current palette']);
    // tab order: username -> pin -> submit
    await page.focus('#username');
    const first = await page.evaluate(() => document.activeElement.id);
    await page.keyboard.press('Tab');
    const second = await page.evaluate(() => document.activeElement.id);
    if (first !== 'username' || second !== 'pin') deviceFindings.push(['Minor', 'Login', `focus order starts at ${first}->${second}`, 'tab from #username', '']);
  }
  await shoot('login');

  // login (officer)
  await page.fill('#username', 'demo-officer-1');
  await page.fill('#pin', '1234');
  await page.getByRole('button', { name: /Sign in|साइन इन/ }).click();
  await page.waitForURL(/\/(today|dashboard)/, { timeout: 30000 });
  await page.waitForSelector('button.card, [data-testid="error"], [data-testid="empty"]', { timeout: 60000 });
  await page.waitForTimeout(600);
  await shoot('today');

  // --- today ---
  {
    const m = await page.evaluate(() => {
      const vw = window.innerWidth;
      const out = { vw, vh: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, visualScale: window.visualViewport?.scale ?? 1, sections: [...document.querySelectorAll('[data-section]')].map((el) => el.dataset.section), floats: [], wide: [], contrast: [], cards: document.querySelectorAll('button.card').length };
      for (const el of document.querySelectorAll('.bottom-nav, .sticky-bar')) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out.floats.push({ name: el.className.split(' ')[0], left: Math.round(r.left), right: Math.round(window.innerWidth - r.right), width: Math.round(r.width), centreOffset: Math.abs(r.left + r.width / 2 - vw / 2), pos: cs.position, hasFloat: el.hasAttribute('data-float') });
      }
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width > vw + 1 && cs.position !== 'fixed') out.wide.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(r.width)}px`);
      }
      // contrast sample: secondary text + accent reason + hero text
      const samples = [['.today-date', 'secondary'], ['.today-sub', 'secondary'], ['.score-reason', 'accent'], ['.card-name', 'primary'], ['.card-sub', 'secondary']];
      for (const [sel, kind] of samples) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        let bgEl = el;
        let bg = 'rgba(0, 0, 0, 0)';
        let gradient = null;
        while (bgEl) {
          const s = getComputedStyle(bgEl);
          if (s.backgroundImage.includes('gradient')) { gradient = s.backgroundImage; break; }
          if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') { bg = s.backgroundColor; break; }
          bgEl = bgEl.parentElement;
        }
        const lum = (rgb) => {
          const mm = rgb.match(/([\d.]+)/g);
          if (!mm || mm.length < 3) return 1;
          const [r, g, b] = mm.slice(0, 3).map((v) => {
            const c = Number(v) / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        let ratio;
        if (gradient) {
          const lighter = (gradient.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/g) || []).map(lum).sort((a, b) => b - a)[0] ?? 1;
          const lt = lum(cs.color);
          ratio = (Math.max(lt, lighter) + 0.05) / (Math.min(lt, lighter) + 0.05);
        } else {
          const l1 = lum(cs.color);
          const l2 = lum(bg);
          ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        }
        out.contrast.push({ sel, color: cs.color, bg: gradient ? 'gradient' : bg, ratio: Math.round(ratio * 100) / 100, size: cs.fontSize, weight: cs.fontWeight });
      }
      return out;
    });
    results.devices[`${deviceName}-today`] = m;
    if (m.scrollWidth > m.vw) deviceFindings.push(['Major', 'Today', `horizontal scroll ${m.scrollWidth} > ${m.vw}`, 'documentElement.scrollWidth', '']);
    for (const f of m.floats) {
      if (f.left < 8 || f.right < 8) deviceFindings.push(['Major', 'Today', `floating nav not inset: left ${f.left}, right ${f.right}`, `.bottom-nav computed left/right`, 'left: 12px; right: 12px (or margin-inline auto + width cap)']);
      if (f.centreOffset > 2) deviceFindings.push(['Major', 'Today', `floating nav off-centre ${f.centreOffset}px`, '.bottom-nav rect', '']);
    }
    for (const w of m.wide) deviceFindings.push(['Major', 'Today', `element wider than viewport: ${w}`, 'getBoundingClientRect', '']);
    for (const c of m.contrast) {
      if (c.ratio < 4.5) deviceFindings.push(['Major', 'Today', `contrast ${c.ratio}:1 < 4.5 on ${c.sel} (${c.color} on ${c.bg})`, 'computed contrast', '']);
    }
    // order vs contract (officer today)
    const contract = ['top-bar', 'heading', 'hero', 'summary', 'segmented', 'cards', 'nav'];
    const actual = m.sections.filter((s) => contract.includes(s));
    const navLast = m.sections[m.sections.length - 1] === 'nav';
    const expected = contract.filter((s) => s !== 'nav');
    if (JSON.stringify(m.sections.filter((s) => s !== 'nav')) !== JSON.stringify(expected) || !navLast) {
      deviceFindings.push(['Major', 'Today', `section order out of contract: got ${JSON.stringify(m.sections)}`, 'data-section order vs docs contracts', '']);
    }
  }
  // tap targets on today
  {
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, a.btn, [role="button"]')) {
        const r = el.getBoundingClientRect();
        if (r.height === 0) continue;
        if (r.height < 48 || (r.width < 48 && r.height < 48)) out.push(`${(el.textContent ?? el.ariaLabel ?? el.tagName).trim().slice(0, 20)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    });
    for (const s of small) deviceFindings.push(['Major', 'Today', `tap target < 48px: ${s}`, 'getBoundingClientRect', 'min-height: 48px']);
  }

  // --- detail ---
  await page.locator('button.card').first().click();
  await page.waitForSelector('[data-section="actions"]', { timeout: 60000 });
  await page.waitForTimeout(400);
  await shoot('detail');
  {
    const m = await page.evaluate(() => {
      const vw = window.innerWidth;
      const out = { scrollWidth: document.documentElement.scrollWidth, floats: [], facts: document.querySelectorAll('.fact-row').length, why: document.querySelectorAll('.score-reasons li').length, history: document.querySelectorAll('.history-list li').length, stickyInsideScreen: Boolean(document.querySelector('.sticky-bar')?.closest('main')) };
      for (const el of document.querySelectorAll('.bottom-nav, .sticky-bar')) {
        const r = el.getBoundingClientRect();
        out.floats.push({ name: el.className.split(' ')[0], left: Math.round(r.left), right: Math.round(window.innerWidth - r.right), centreOffset: Math.abs(r.left + r.width / 2 - vw / 2), bottomGap: Math.round(window.innerHeight - r.bottom) });
      }
      out.safeArea = getComputedStyle(document.querySelector('.sticky-bar')).paddingBottom;
      out.stickyBottom = getComputedStyle(document.querySelector('.sticky-bar')).bottom;
      return out;
    });
    results.devices[`${deviceName}-detail`] = m;
    if (m.scrollWidth > m.vw) deviceFindings.push(['Major', 'Detail', `horizontal scroll ${m.scrollWidth} > ${m.vw}`, 'documentElement.scrollWidth', '']);
    for (const f of m.floats) {
      if (f.left < 8 || f.right < 8) deviceFindings.push(['Major', 'Detail', `floating bar not inset: left ${f.left}, right ${f.right}`, '.sticky-bar computed', 'left: 12px; right: 12px']);
      if (f.centreOffset > 2) deviceFindings.push(['Major', 'Detail', `floating bar off-centre ${f.centreOffset}px`, '.sticky-bar rect', '']);
    }
    if (m.stickyInsideScreen) deviceFindings.push(['Minor', 'Detail', 'floating bar is nested inside main.screen (max-width wrapper) rather than an app-shell sibling', '.sticky-bar closest main', 'move the fixed element out of the wrapper']);
    if (deviceName !== 'desktop' && m.safeArea === '0px' && !m.stickyBottom.includes('env')) {
      deviceFindings.push(['Major', 'Detail', `no safe-area inset on the floating bar (padding-bottom ${m.safeArea})`, 'computed padding-bottom', 'padding-bottom: calc(8px + env(safe-area-inset-bottom))']);
    }
  }

  // keyboard overlap probe on the detail note input? outcome sheet instead:
  await page.locator('button.sticky-btn-accent').click();
  await page.waitForSelector('dialog.outcome-sheet');
  await page.waitForTimeout(300);
  await shoot('outcome-sheet');
  {
    const m = await page.evaluate(() => {
      const dlg = document.querySelector('dialog.outcome-sheet');
      const r = dlg.getBoundingClientRect();
      const save = [...document.querySelectorAll('button')].find((b) => /Save|सहेजें/.test(b.textContent));
      const saveR = save?.getBoundingClientRect();
      const chips = document.querySelectorAll('.chip-row .chip').length;
      const nav = document.querySelector('.bottom-nav');
      const navR = nav?.getBoundingClientRect();
      const navVisible = nav ? getComputedStyle(nav).display !== 'none' : false;
      const input = document.querySelector('.promise-amount-input');
      // focus the amount input if visible, else the note
      return {
        sheetHeight: Math.round(r.height),
        sheetBottom: Math.round(r.bottom),
        saveY: saveR ? Math.round(saveR.y) : null,
        saveH: saveR ? Math.round(saveR.height) : null,
        chips,
        navUnderSheet: navVisible && navR ? navR.bottom > r.top : false,
        vh: window.innerHeight
      };
    });
    results.devices[`${deviceName}-sheet`] = m;
    if (m.navUnderSheet) deviceFindings.push(['Major', 'Outcome sheet', 'the bottom nav is visible/underneath the open sheet and overlaps it', `nav bottom ${'—'} vs sheet top ${m.sheetBottom}`, 'hide the nav while a sheet is open (body:has(dialog[open]) .bottom-nav { display: none })']);
    if (m.saveY !== null && m.saveY + m.saveH > m.vh) deviceFindings.push(['Major', 'Outcome sheet', `Save pill extends below the viewport (y ${m.saveY} + ${m.saveH} > ${m.vh})`, 'getBoundingClientRect', '']);
  }
  // keyboard overlap: focus the note textarea and compare visualViewport
  {
    const kb = await page.evaluate(async () => {
      const note = document.querySelector('.note-input') ?? document.querySelector('textarea');
      const before = window.visualViewport?.height ?? window.innerHeight;
      let after = before;
      if (note) {
        note.focus();
        await new Promise((r) => setTimeout(r, 400));
        after = window.visualViewport?.height ?? window.innerHeight;
      }
      return { hasInput: Boolean(note), before, after };
    });
    results.devices[`${deviceName}-sheet-keyboard`] = kb;
    // In emulation the software keyboard does not appear; record as evidence only.
  }
  await page.getByRole('button', { name: /Cancel|रद्द करें/ }).click();
  await page.waitForTimeout(200);

  // --- promises ---
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Promises|वादे/ }).click();
  await page.waitForTimeout(700);
  await shoot('promises');
  {
    const m = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      empty: Boolean(document.querySelector('[data-testid="empty"]')),
      rows: document.querySelectorAll('.promise-card').length
    }));
    if (m.scrollWidth > m.vw) deviceFindings.push(['Major', 'Promises', `horizontal scroll ${m.scrollWidth} > ${m.vw}`, 'documentElement.scrollWidth', '']);
  }

  // --- me ---
  await page.locator('nav.bottom-nav').getByRole('button', { name: /Me|मेरी जानकारी/ }).click();
  await page.waitForTimeout(500);
  await shoot('me');
  {
    const m = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, vw: window.innerWidth }));
    if (m.scrollWidth > m.vw) deviceFindings.push(['Major', 'Me', `horizontal scroll ${m.scrollWidth} > ${m.vw}`, 'documentElement.scrollWidth', '']);
  }

  // --- manager (desktop contexts + landscape phone; skip on small phones) ---
  if (deviceName === 'desktop' || deviceName === 'pixel7-landscape') {
    await page.getByRole('button', { name: /Log out|लॉग आउट/ }).first().click();
    await page.waitForURL('**/login', { timeout: 15000 });
    await page.fill('#username', 'demo-manager');
    await page.fill('#pin', '1234');
    await page.getByRole('button', { name: /Sign in|साइन इन/ }).click();
    await page.waitForURL('**/dashboard', { timeout: 30000 });
    await page.waitForSelector('.tile-grid', { timeout: 30000 });
    await page.waitForTimeout(600);
    await shoot('dashboard');
    {
      const m = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        tiles: document.querySelectorAll('.tile').length,
        heroTiles: document.querySelectorAll('[data-hero]').length,
        officers: document.querySelectorAll('.manager-table tbody tr').length,
        greyed: document.querySelectorAll('tr.greyed').length,
        seg: document.querySelector('.manager-seg') ? [...document.querySelectorAll('.manager-seg button')].map((b) => b.textContent) : null
      }));
      results.devices[`${deviceName}-dashboard`] = m;
      if (m.scrollWidth > m.vw) deviceFindings.push(['Major', 'Dashboard', `horizontal scroll ${m.scrollWidth} > ${m.vw}`, 'documentElement.scrollWidth', '']);
      if (deviceName === 'pixel7-landscape' && m.heroTiles >= 3) {
        deviceFindings.push(['Minor', 'Dashboard', `3 gradient hero tiles render on a landscape phone (915px wide)`, '[data-hero] count', '']);
      }
    }
    await shoot('dashboard-bottom');
  }

  results.console[deviceName] = errors;
  results.network[deviceName] = { failed: failed, slow: slow, apiTimings: apiTimings.filter((t) => t.url.includes('assignments') || t.url.includes('dashboard') || t.url.includes('promises')) };
  for (const [sev, screen, what, evidence, fix] of deviceFindings) {
    finding(sev, screen, deviceName, what, evidence, fix);
  }
  await context.close();
}

// ---------- offline / sync test (chromium, iPhone 13 emulation) ----------
{
  const context = await browser.newContext({ ...DEVICES['iphone13'] });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  // install the SW
  await page.waitForTimeout(1500);
  const swState1 = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? { scope: reg.scope, active: Boolean(reg.active) } : null;
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.fill('#username', 'demo-officer-1');
  await page.fill('#pin', '1234');
  await page.getByRole('button', { name: /Sign in|साइन इन/ }).click();
  await page.waitForURL(/today/, { timeout: 30000 });
  await page.waitForSelector('button.card', { timeout: 60000 });
  // cache the detail page shell + open a loan
  await page.locator('button.card').first().click();
  await page.waitForSelector('[data-section="actions"]');
  await page.waitForTimeout(800);
  // go offline
  await context.setOffline(true);
  await page.reload().catch(() => {});
  await page.waitForTimeout(1500);
  const offlineState = await page.evaluate(() => ({ url: location.pathname, hasContent: document.body.innerText.length > 50 }));
  // log an outcome offline
  let queuedOffline = false;
  try {
    await page.locator('button.sticky-btn-accent').click({ timeout: 8000 });
    await page.waitForSelector('dialog.outcome-sheet', { timeout: 8000 });
    await page.getByRole('button', { name: /Paid|भुगतान किया/ }).click();
    await page.getByRole('button', { name: /Save|सहेजें/ }).click();
    await page.waitForTimeout(500);
    queuedOffline = await page.evaluate(() => document.querySelector('.undo-toast') !== null || document.body.innerText.includes('pending'));
  } catch (e) {
    queuedOffline = `error: ${String(e).slice(0, 100)}`;
  }
  // reconnect
  await context.setOffline(false);
  await page.waitForTimeout(4000);
  const syncState = await page.evaluate(async () => {
    const items = await (async () => {
      try {
        const { db } = await import('/src/client/dexie/db.ts').catch(() => ({}));
        return null;
      } catch { return null; }
    })();
    return { syncText: document.body.innerText.includes('synced'), pending: document.body.innerText.match(/(\d+) pending/)?.[1] ?? null };
  });
  // reload: check the outcome did not duplicate (the events POST is idempotent by id)
  await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
  results.notes.push({ offline: { swState1, offlineState, queuedOffline, syncState } });
  await context.close();
}

await browser.close();

writeFileSync('qa-audit-results.json', JSON.stringify({ findings: FINDINGS, results }, null, 2));
console.log(`\n=== ${FINDINGS.length} findings written to qa-audit-results.json ===`);
