// Run against a served checkout with Playwright on NODE_PATH.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8765/';
const ready = page => page.waitForSelector('body:not(.loading):not(.load-failed)');
const bounds = page => {
  const value = new URL(page.url()).searchParams.get('y_range');
  return value ? value.split(',').map(Number) : null;
};
const toggle = (page, mode) => page.locator(`label:has(#prng-${mode})`);
const hoverLatest = async page => {
  const plot = await page.locator('#svg').boundingBox();
  // The right edge selects the latest of the two fixture runs.
  await page.mouse.move(plot.x + plot.width * 0.9, plot.y + plot.height / 2);
  await page.waitForSelector('#tip:not([hidden])');
  return page.locator('#tip > ol li').evaluateAll(rows => Object.fromEntries(
    rows.map(row => [row.querySelector('.name').textContent, row.querySelector('b').textContent])));
};

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); // Desktop keeps all controls available.
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // Two runs let fitted bounds cover an interval and let keyboard navigation pin an earlier run.
    const times = ['2026-10-01T00:00:00Z', '2026-10-01T06:00:00Z'];
    const csv = 'snapshot_ts,team,pub_points,pub_max_points,held_points,held_max_points,pub_rng_pct,held_rng_pct\n' +
      times.flatMap((t, i) => [
        `${t},Alpha,1,3,1,1,${i ? 99 : 97},${i ? 100 : 98}`, // Unequal pool weights distinguish weighting from averaging.
        `${t},Perfect,1,3,1,1,100,100`, // Exact zero remaining.
        `${t},Almost,1,3,1,1,99.9999,99.9999`, // Nonzero remainder too small for three decimals.
        `${t},Missing,,,,,,`, // Missing matches must remain gaps, not become 100% remaining.
      ]).join('\n');
    let release;
    const released = new Promise(resolve => { release = resolve; });
    await page.route('**/data/leaderboard.csv', async route => {
      await released;
      await route.fulfill({ contentType: 'text/csv', body: csv });
    });
    await page.goto(`${base}?metric=prng&pool=public&teams=Alpha,Perfect,Almost,Missing&duration=all`);
    assert.equal(await page.locator('#prng-remaining').isDisabled(), true, 'toggle waits for data');
    release();
    await ready(page);
    assert.equal(await page.locator('#prng-view').isVisible(), true);
    await page.locator('#fit-highlighted').click();
    const matched = await bounds(page);
    assert.ok(matched);
    const table = await page.locator('#tbody').textContent();
    const before = await page.locator('#svg').boundingBox();
    await toggle(page, 'remaining').click();
    assert.deepEqual(await bounds(page), [100 - matched[1], 100 - matched[0]]); // Complement the interval endpoints and reverse their order.
    assert.equal(await page.locator('#chart-title').textContent(), 'PRNG remaining');
    assert.deepEqual(await page.locator('#svg').boundingBox(), before, 'toggle keeps the chart frame');
    assert.equal(await page.locator('#tbody').textContent(), table, 'standings continue to show matched scores');
    assert.deepEqual(await hoverLatest(page), { Alpha: '1.000%', Perfect: '0.000%', Almost: '<0.001%' }); // Latest public Alpha is 99% matched; missing data produces no tooltip row.
    const shared = page.url();
    const remaining = await bounds(page);
    await page.reload();
    await ready(page);
    assert.deepEqual(await bounds(page), remaining, 'reload restores the displayed bounds without complementing twice');
    assert.equal(await page.locator('#prng-remaining').isChecked(), true);
    const fresh = await browser.newPage();
    await fresh.route('**/data/leaderboard.csv', route => route.fulfill({ contentType: 'text/csv', body: csv }));
    await fresh.goto(shared);
    await ready(fresh);
    assert.deepEqual(await bounds(fresh), remaining, 'shared view works without saved preferences');
    assert.equal(await fresh.locator('#prng-remaining').isChecked(), true);
    await fresh.close();
    await page.goto(base);
    await ready(page);
    assert.equal(await page.locator('#prng-remaining').isChecked(), true, 'bare URL restores saved view');
    await toggle(page, 'matched').click();
    const restored = await bounds(page);
    restored.forEach((v, i) => assert.ok(Math.abs(v - matched[i]) < 1e-10)); // Allow only floating-point round-trip error.
    assert.equal(new URL(page.url()).searchParams.has('prng_view'), false, 'matched is the default URL form');

    // A keyboard switch while scrolled must keep focus, scroll, highlights, window, and pinned run.
    await page.locator('#svg').focus();
    await page.keyboard.press('ArrowLeft');
    const pin = new URL(page.url()).searchParams.get('as_of');
    const teams = new URL(page.url()).searchParams.get('teams');
    await page.locator('#prng-matched').focus();
    const scroll = await page.evaluate(() => scrollY);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#prng-remaining').isChecked(), true);
    assert.equal(await page.locator('#prng-remaining').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.evaluate(() => scrollY), scroll);
    assert.equal(new URL(page.url()).searchParams.get('as_of'), pin);
    assert.equal(new URL(page.url()).searchParams.get('teams'), teams);
    assert.equal(new URL(page.url()).searchParams.get('duration'), 'all');

    // Pool changes reset the axis but keep the selected representation; combined values are weighted first.
    await page.locator('label:has(#pool-combined)').click();
    assert.equal(await bounds(page), null);
    assert.equal((await hoverLatest(page)).Alpha, '0.750%'); // Public has three times held-out's weight: (99*3 + 100)/4 = 99.25% matched.
    await toggle(page, 'matched').click();
    assert.equal(await bounds(page), null, 'automatic scaling remains automatic');
    await page.locator('label:has(#metric-points)').click();
    assert.equal(await page.locator('#prng-view').isVisible(), false, 'PRNG view is not offered for count or speed metrics');
    await page.locator('label:has(#metric-prng)').click();
    await toggle(page, 'remaining').click();

    // Empty and flat highlighted series must retain fit behavior in remaining mode.
    await page.goto(`${base}?metric=prng&prng_view=remaining&teams=Missing`);
    await ready(page);
    assert.equal(await page.locator('#fit-highlighted').getAttribute('aria-disabled'), 'true');
    await page.goto(`${base}?metric=prng&prng_view=remaining&teams=Perfect`);
    await ready(page);
    await page.locator('#fit-highlighted').click();
    const flat = await bounds(page);
    assert.ok(flat[0] === 0 && flat[1] > flat[0] && flat[1] <= 100); // Zero remainder must have a usable domain within percentage bounds.

    // Toggle at phone, landscape and intermediate widths; the chart and page must not jump or overflow.
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [900, 800], [1280, 900]]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => document.querySelector('#svg').getAttribute('width') ===
        String(Math.max(280, document.querySelector('#chart').clientWidth)));
      const frame = await page.locator('#svg').boundingBox();
      await toggle(page, 'matched').click();
      await toggle(page, 'remaining').click();
      assert.deepEqual(await page.locator('#svg').boundingBox(), frame);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.goto(`${base}?metric=prng&prng_view=invalid&teams=Alpha`);
    await ready(page);
    assert.equal(await page.locator('#prng-matched').isChecked(), true, 'invalid mode uses matched');
    assert.deepEqual(errors, []);
    console.log('Remaining PRNG: delayed data, complemented fit, tooltips, pools, gaps, persistence, links, keyboard, selection and responsive layout passed.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
