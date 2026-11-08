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
// scroll to the very bottom
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await page.waitForTimeout(400);
const info = await page.evaluate(() => {
  const nav = document.querySelector('.bottom-nav');
  const navRect = nav?.getBoundingClientRect();
  // everything that paints at or below the nav top, in the bottom strip
  const below = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    if (navRect && r.top >= navRect.top - 2 && !nav.contains(el) && el !== nav) {
      const s = getComputedStyle(el);
      if (s.position === 'fixed') continue;
      below.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 40), top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), bg: s.backgroundColor, bb: s.borderBottomWidth, borderCol: s.borderBottomColor });
    }
  }
  // scroll end state
  return {
    navTop: Math.round(navRect?.top ?? -1), navBottom: Math.round(navRect?.bottom ?? -1), vh: innerHeight,
    scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    belowCount: below.length,
    below: below.slice(0, 12)
  };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: '/tmp/qa20-band.png' });
await browser.close();
