import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5173';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const page = await context.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#username', 'demo-officer-1');
await page.fill('#pin', '1234');
await page.getByRole('button', { name: /Sign in|साइन इन/ }).click();
await page.waitForURL(/\/today/, { timeout: 15000 });
await page.locator('nav.bottom-nav').getByRole('button', { name: /Promises|वादे/ }).click();
await page.waitForURL('**/promises');
await page.waitForTimeout(1200);
for (let settle = 0; settle < 5; settle += 1) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(400);
}
const spans = await page.evaluate(() => {
  const nav = document.querySelector('.bottom-nav');
  const navRect = nav.getBoundingClientRect();
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 || getComputedStyle(el).position === 'fixed') continue;
    if (rect.top >= navRect.top - 2) {
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === 'string' ? el.className : String(el.className?.baseVal ?? ''),
        text: (el.textContent ?? '').slice(0, 40),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom)
      });
    }
  }
  return { navTop: Math.round(navRect.top), scrollY: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight, els: out.slice(0, 8) };
});
console.log(JSON.stringify(spans, null, 2));
await browser.close();
