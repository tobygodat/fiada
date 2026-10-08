import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
const [mode, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(mode === 'after' ? { recordVideo: { dir: out + '/video', size: { width: 1440, height: 900 } } } : {}) });
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
  const body = execFileSync('curl', ['-sS', route.request().url(), '-H', 'user-agent: ' + (await route.request().headerValue('user-agent'))], { maxBuffer: 1e8 });
  await route.fulfill({ body, headers: { 'content-type': route.request().url().includes('css') ? 'text/css' : 'font/woff2', 'access-control-allow-origin': '*' } });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5178/');
await page.waitForSelector('.map-canvas');
await page.waitForTimeout(2500);
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok:', m); };
if (mode === 'before') {
  await page.screenshot({ path: out + '/before.png' });
  assert((await page.locator('.search input').count()) === 0, 'no search box before');
} else {
  const input = page.locator('.search input');
  assert(await input.isVisible(), 'search box in the top bar');
  await page.screenshot({ path: out + '/after-idle.png' });
  // "/" focuses it from the map.
  await page.mouse.click(700, 500);
  await page.keyboard.press('/');
  assert(await input.evaluate((el) => el === document.activeElement), '"/" focuses the search box');
  await page.keyboard.type('create_item', { delay: 90 });
  await page.waitForSelector('.search-hits li[role=option]');
  const first = await page.locator('.search-hits li[role=option]').first().innerText();
  assert(first.includes('create_item'), 'first match is create_item: ' + first.replace(/\n/g, ' · '));
  await page.waitForTimeout(500);
  await page.screenshot({ path: out + '/after-matches.png' });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1600);
  const sel = await page.evaluate(() => document.querySelector('.detail h2, .detail .title, .detail')?.textContent?.slice(0, 120));
  assert(sel && sel.includes('create_item'), 'Enter selects create_item and opens its details: ' + sel);
  const crumbs = await page.locator('.crumbs').innerText();
  assert(crumbs.includes('items.py'), 'the way to it is open: ' + crumbs.replace(/\n/g, ' '));
  await page.screenshot({ path: out + '/after-picked.png' });
  // Ctrl-K, arrows, and a file.
  await page.keyboard.press('Control+k');
  assert(await input.evaluate((el) => el === document.activeElement), 'Ctrl-K focuses the search box');
  await page.keyboard.type('models', { delay: 90 });
  await page.waitForTimeout(400);
  const n = await page.locator('.search-hits li[role=option]').count();
  assert(n >= 2, n + ' matches for models');
  await page.keyboard.press('ArrowDown');
  const active = await page.locator('.search-hits li[aria-selected=true]').innerText();
  assert(active === (await page.locator('.search-hits li[role=option]').nth(1).innerText()), 'ArrowDown moves to the second match');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  await page.screenshot({ path: out + '/after-arrows.png' });
  // Esc clears the query but keeps the selection on the map.
  await page.keyboard.press('Escape');
  assert((await input.inputValue()) === '', 'Esc clears the query');
  assert((await page.locator('.search-hits').count()) === 0, 'list closes');
  const still = await page.evaluate(() => document.querySelector('.detail')?.textContent?.includes('create_item'));
  assert(still, 'Esc in the search box keeps the map selection');
  // Mouse pick.
  await input.click();
  await page.keyboard.type('login', { delay: 90 });
  await page.waitForTimeout(400);
  const pickName = await page.locator('.search-hits li[role=option] .search-name').first().innerText();
  await page.locator('.search-hits li[role=option]').first().click();
  await page.waitForTimeout(1600);
  const d2 = await page.evaluate(() => document.querySelector('.detail')?.textContent ?? '');
  assert(d2.includes(pickName), 'click picks ' + pickName);
  await page.screenshot({ path: out + '/after-click.png' });
  // Nothing matches.
  await input.click();
  await page.keyboard.type('qqqzzz');
  assert((await page.locator('.search-none').innerText()) === 'nothing called that', 'says when nothing matches');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // Light theme.
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await input.click();
  await page.keyboard.type('item', { delay: 60 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: out + '/after-light.png' });
}
assert(errors.length === 0, 'no page errors ' + errors.join('; '));
const vid = page.video();
await ctx.close();
if (vid) await vid.saveAs(out + '/flow.webm');
await browser.close();
