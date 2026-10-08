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
  // Enter that commits an IME composition doesn't pick.
  await input.fill('');
  await input.click();
  await page.keyboard.type('item', { delay: 20 });
  await page.waitForTimeout(200);
  await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  await page.waitForTimeout(200);
  assert((await page.locator('.search-hits').count()) === 1 && (await input.evaluate((el) => el === document.activeElement)), 'Enter during IME composition keeps typing instead of picking');
  await page.keyboard.press('Escape');
  // A bare click event (as assistive tech and switch devices send) picks too.
  await input.fill('');
  await input.click();
  await page.keyboard.type('read_items', { delay: 40 });
  await page.waitForTimeout(300);
  const where = await page.locator('.search-hits li[role=option] .search-where').first().innerText();
  assert(/items\.py:\d+$/.test(where), 'a symbol says its file and line: ' + where);
  await page.evaluate(() => document.querySelector('.search-hits li[role=option]').click());
  await page.waitForTimeout(1600);
  const d4 = await page.evaluate(() => document.querySelector('.detail')?.textContent ?? '');
  assert(d4.includes('read_items'), 'a click event alone picks read_items');
  await input.fill('');
  // Nothing matches.
  await input.click();
  await page.keyboard.type('qqqzzz');
  assert((await page.locator('.search-none').innerText()) === 'nothing called that', 'says when nothing matches');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // The active row stays in sight as the arrows go down a long list.
  await page.setViewportSize({ width: 1440, height: 600 });
  await input.click();
  await page.keyboard.type('item', { delay: 40 });
  await page.waitForTimeout(300);
  for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  const inView = await page.evaluate(() => {
    const ul = document.querySelector('.search-hits'), li = document.querySelector('.search-hits li[aria-selected=true]');
    const a = ul.getBoundingClientRect(), b = li.getBoundingClientRect();
    return ul.scrollHeight > ul.clientHeight && b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
  });
  assert(inView, 'the twelfth match is scrolled into view in a short window');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  // Keyboard focus keeps the focus ring.
  await page.keyboard.press('/');
  const ring = await input.evaluate((el) => getComputedStyle(el).outlineStyle);
  assert(ring === 'solid', 'the focus ring shows on keyboard focus');
  await page.keyboard.press('Escape');
  // By function: only what that view draws, and a pick lands.
  await page.getByRole('button', { name: 'by function' }).click().catch(() => page.getByText('by function', { exact: true }).click());
  await page.waitForTimeout(1500);
  await input.click();
  await page.keyboard.type('backend', { delay: 40 });
  await page.waitForTimeout(300);
  const kinds = await page.locator('.search-hits .search-kind').allInnerTexts();
  assert(!kinds.some((k) => k === 'folder' || k === 'repo'), 'by function lists no repos or folders: ' + kinds.join(','));
  await page.keyboard.press('Escape');
  await page.keyboard.type('create_item', { delay: 40 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1600);
  const d3 = await page.evaluate(() => document.querySelector('.detail')?.textContent ?? '');
  assert(d3.includes('create_item'), 'by function: Enter selects create_item');
  await page.screenshot({ path: out + '/after-by-function.png' });
  await page.keyboard.press('Escape');
  await page.getByText('code', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  // A narrow window keeps the whole list on screen.
  for (const w of [320, 360, 480, 761, 841, 900]) {
    await page.setViewportSize({ width: w, height: 800 });
    const bar = await page.evaluate((w) => {
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const back = r('.crumbs .back'), crumb = r('.crumbs button:nth-of-type(2)'), field = r('.search input'), zoom = r('.zoom');
      const inside = [back, crumb, field, zoom].every((b) => b && b.width > 0 && b.left >= 0 && b.right <= w + 1);
      return inside && back.width >= 30 && crumb.right <= field.left && field.right <= zoom.left;
    }, w);
    assert(bar, `the top bar fits a ${w}px window: back, breadcrumb, search and zoom all show without overlapping`);
    // While indexing, the "indexing…" word joins the bar (as TopBar renders it, after search).
    const busyBar = await page.evaluate((w) => {
      const span = document.createElement('span');
      span.className = 'muted small busy';
      span.textContent = 'indexing…';
      document.querySelector('.search').after(span);
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const back = r('.crumbs .back'), crumb = r('.crumbs button:nth-of-type(2)'), field = r('.search input'), busy = r('.busy');
      const crumbEl = document.querySelector('.crumbs button:nth-of-type(2)');
      const ok = [back, crumb, field, busy].every((b) => b && b.width > 0 && b.left >= 0 && b.right <= w + 1) && crumbEl.scrollWidth <= crumbEl.clientWidth + 1 && crumb.right <= field.left && field.right <= busy.left;
      span.remove();
      return ok;
    }, w);
    assert(busyBar, `while indexing, back, the whole breadcrumb, search and "indexing…" fit a ${w}px window`);
    await input.fill('');
    await input.click();
    await page.keyboard.type('item', { delay: 20 });
    await page.waitForTimeout(300);
    const box = await page.locator('.search-hits').boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= w + 1, `the list fits a ${w}px window (${Math.round(box.x)}..${Math.round(box.x + box.width)})`);
    if (w === 480) await page.screenshot({ path: out + '/after-narrow.png' });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
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
