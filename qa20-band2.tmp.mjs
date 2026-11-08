import { chromium, devices } from '@playwright/test';
const BASE = 'http://localhost:4173';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 3 });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
await page.fill('#username', 'demo-officer-1');
await page.fill('#pin', '1234');
await page.getByRole('button', { name: /साइन इन|Sign in/ }).click();
await page.waitForSelector('button.card', { timeout: 60000 });

const probe = async (name) => {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(350);
  const info = await page.evaluate(() => {
    const nav = document.querySelector('.bottom-nav');
    const navRect = nav?.getBoundingClientRect();
    const below = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      if (navRect && r.top >= navRect.top - 2 && !nav.contains(el) && el !== nav && getComputedStyle(el).position !== 'fixed') {
        const s = getComputedStyle(el);
        below.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 44), top: Math.round(r.top), h: Math.round(r.height), bg: s.backgroundColor, bwidth: `${s.borderTopWidth}/${s.borderBottomWidth}` });
      }
    }
    // last interactive control position
    const controls = [...document.querySelectorAll('main button, main a, main input, main select')].filter((el) => el.getBoundingClientRect().height > 0);
    const last = controls[controls.length - 1];
    return {
      scrollY: Math.round(scrollY), maxScroll: Math.round(document.documentElement.scrollHeight - innerHeight),
      navTop: Math.round(navRect?.top ?? -1),
      below, lastControl: last ? { text: (last.textContent ?? last.tagName).slice(0, 24), bottom: Math.round(last.getBoundingClientRect().bottom), cls: String(last.className).slice(0, 30) } : null
    };
  });
  console.log(`=== ${name} ===`);
  console.log(JSON.stringify(info, null, 1));
  await page.screenshot({ path: `/tmp/qa20-band-${name}.png` });
};

await page.locator('nav.bottom-nav').getByRole('button', { name: /मेरी जानकारी|Me/ }).first().click();
await page.waitForTimeout(900);
await probe('me');
await page.locator('nav.bottom-nav').getByRole('button', { name: /आज|Today/ }).first().click();
await page.waitForTimeout(700);
await page.locator('button.card').first().click();
await page.waitForSelector('[data-section="actions"]', { timeout: 30000 });
await probe('detail');
await browser.close();
