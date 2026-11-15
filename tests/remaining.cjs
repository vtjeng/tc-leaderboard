// Run against a served checkout with Playwright on NODE_PATH.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8765/';
const ready = page => page.waitForSelector('body:not(.loading):not(.load-failed)');
const bounds = page => {
  const value = new URL(page.url()).searchParams.get('y_range');
  return value ? value.split(',').map(Number) : null;
};
const toggle = (page, mode) => page.locator(`label:has(#display-${mode})`);
const hoverLatest = async page => {
  await page.locator('#svg').scrollIntoViewIfNeeded();
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
    const csv = 'snapshot_ts,team,pub_points,pub_max_points,held_points,held_max_points,pub_rng_pct,held_rng_pct,pub_passing,pub_total,held_passing,held_total,pub_anim_matched,pub_anim_total,held_anim_matched,held_anim_total,speed_startup_ms,speed_per_move_ms\n' +
      times.flatMap((t, i) => [
        `${t},Alpha,${i ? 2 : 1},3,1,1,${i ? 99 : 97},${i ? 100 : 98},${i ? 1 : 0},${i ? 3 : 2},1,1,${i ? 8 : 6},10,2,4,123,1.25`, // Unequal weights test PRNG pooling; session totals change between runs; improving points test tints. Timings stay unchanged.
        `${t},Perfect,3,3,1,1,100,100,3,3,1,1,10,10,4,4,123,1.25`, // Exact zero remaining.
        `${t},Almost,1,3,0,1,99.9999,99.9999,1,3,0,1,6,10,1,4,123,1.25`, // Nonzero remainder too small for three decimals.
        `${t},Missing,,,,,,`, // Missing matches must remain gaps, not become 100% remaining.
      ]).join('\n');
    let release;
    const released = new Promise(resolve => { release = resolve; });
    await page.route('**/data/leaderboard.csv', async route => {
      await released;
      await route.fulfill({ contentType: 'text/csv', body: csv });
    });
    await page.goto(`${base}?metric=prng&pool=public&teams=Alpha,Perfect,Almost,Missing&duration=all`);
    assert.equal(await page.locator('#topbar #display-seg').count(), 1, 'Remaining belongs with the global controls');
    assert.equal(await page.locator('#display-remaining').isDisabled(), true, 'toggle waits for data');
    release();
    await ready(page);
    assert.equal(await page.locator('#display-seg').isVisible(), true);
    await page.locator('#fit-highlighted').click();
    const matched = await bounds(page);
    assert.ok(matched);
    const table = await page.locator('#tbody').textContent();
    const speed = await page.locator('tr[data-team=Alpha] td.speed').textContent();
    const order = await page.locator('#tbody tr').evaluateAll(rows => rows.map(row => row.dataset.team));
    const columns = () => page.locator('#thead th').evaluateAll(cells => cells.map(cell => {
      const { x, width } = cell.getBoundingClientRect();
      return { x, width };
    }));
    const matchedColumns = await columns();
    const before = await page.locator('#svg').boundingBox();
    await toggle(page, 'remaining').click();
    assert.deepEqual(await bounds(page), [100 - matched[1], 100 - matched[0]]); // Complement the interval endpoints and reverse their order.
    assert.equal(await page.locator('#chart-title').textContent(), 'PRNG remaining');
    assert.deepEqual(await page.locator('#svg').boundingBox(), before, 'toggle keeps the chart frame');
    assert.deepEqual(await columns(), matchedColumns, 'toggle keeps table column boundaries');
    assert.notEqual(await page.locator('#tbody').textContent(), table, 'global toggle changes the standings');
    assert.equal(await page.locator('tr[data-team=Alpha] [data-score=prng-pub]').textContent(), '1.000%'); // Latest public match is 99%.
    assert.equal(await page.locator('tr[data-team=Missing] [data-score=prng-pub]').textContent(), '—'); // Missing stays missing in the table too.
    assert.equal(await page.locator('#tbody td[data-score]').evaluateAll(cells => cells.every(c => c.getAnimations().length === 0)), true, 'a view switch is not a scoring change');
    for (const [metric, expected] of [['points', '1'], ['sessions', '2'], ['anim', '2']]) { // Latest public totals minus matches: 3−2, 3−1, and 10−8.
      assert.equal(await page.locator(`tr[data-team=Alpha] [data-score=${metric}-pub]`).textContent(), expected);
    }
    assert.equal(await page.locator('tr[data-team=Alpha] td.speed').textContent(), speed);
    assert.deepEqual(await page.locator('#tbody tr').evaluateAll(rows => rows.map(row => row.dataset.team)), order, 'default switches from most matched to fewest remaining');
    assert.equal(await page.locator('#thead th[aria-sort]').getAttribute('aria-sort'), 'ascending');
    assert.deepEqual(await hoverLatest(page), { Alpha: '1.000%', Perfect: '0.000%', Almost: '<0.001%' }); // Latest public Alpha is 99% matched; missing data produces no tooltip row.
    const shared = page.url();
    const remaining = await bounds(page);
    await page.reload();
    await ready(page);
    assert.deepEqual(await bounds(page), remaining, 'reload restores the displayed bounds without complementing twice');
    assert.equal(await page.locator('#display-remaining').isChecked(), true);
    const fresh = await browser.newPage();
    await fresh.route('**/data/leaderboard.csv', route => route.fulfill({ contentType: 'text/csv', body: csv }));
    await fresh.goto(shared);
    await ready(fresh);
    assert.deepEqual(await bounds(fresh), remaining, 'shared view works without saved preferences');
    assert.equal(await fresh.locator('#display-remaining').isChecked(), true);
    await fresh.close();
    await page.goto(base);
    await ready(page);
    assert.equal(await page.locator('#display-remaining').isChecked(), true, 'bare URL restores saved view');
    await toggle(page, 'matched').click();
    const restored = await bounds(page);
    restored.forEach((v, i) => assert.ok(Math.abs(v - matched[i]) < 1e-10)); // Allow only floating-point round-trip error.
    assert.equal(new URL(page.url()).searchParams.has('display'), false, 'matched is the default URL form');

    // A keyboard switch while scrolled must keep focus, scroll, highlights, window, and pinned run.
    await page.locator('#svg').focus();
    await page.keyboard.press('ArrowLeft');
    const pin = new URL(page.url()).searchParams.get('as_of');
    const teams = new URL(page.url()).searchParams.get('teams');
    await page.locator('#display-matched').focus();
    const scroll = await page.evaluate(() => scrollY);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#display-remaining').isChecked(), true);
    assert.equal(await page.locator('#display-remaining').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.evaluate(() => scrollY), scroll);
    assert.equal(new URL(page.url()).searchParams.get('as_of'), pin);
    assert.equal(new URL(page.url()).searchParams.get('teams'), teams);
    assert.equal(new URL(page.url()).searchParams.get('duration'), 'all');
    assert.equal(await page.locator('tr[data-team=Alpha] [data-score=sessions-pub]').textContent(), '2'); // The earlier run has two sessions, with none matched; do not use the latest run's total of three.
    await page.locator('#st-last').click();

    // Pool changes reset the axis but keep the selected representation; combined values are weighted first.
    await page.locator('label:has(#pool-combined)').click();
    assert.equal(await bounds(page), null);
    for (const [metric, expected] of [['points', '1'], ['sessions', '2'], ['anim', '4']]) { // Combined sums each pool's unmatched counts.
      assert.equal(await page.locator(`tr[data-team=Alpha] [data-score=${metric}-combined]`).textContent(), expected);
    }
    assert.equal((await hoverLatest(page)).Alpha, '0.750%'); // Public has three times held-out's weight: (99*3 + 100)/4 = 99.25% matched.
    await page.locator('#thead button[data-key=prng-combined]').click();
    assert.equal(await page.locator('#thead th[aria-sort]').getAttribute('aria-sort'), 'ascending', 'a new remaining score sort starts with the fewest');
    assert.equal(await page.locator('#tbody tr').first().getAttribute('data-team'), 'Perfect');
    await page.locator('#thead button[data-key=prng-combined]').click();
    assert.equal(await page.locator('#tbody tr').first().getAttribute('data-team'), 'Alpha', 'repeated sort reverses the displayed remaining values');
    await toggle(page, 'matched').click();
    assert.equal(await bounds(page), null, 'automatic scaling remains automatic');
    await page.locator('label:has(#metric-points)').click();
    assert.equal(await page.locator('#display-seg').isVisible(), true, 'display control applies globally');
    await page.locator('label:has(#metric-prng)').click();
    await toggle(page, 'remaining').click();

    // Every count metric converts a fitted interval using the window's maximum.
    for (const [metric, maximum, expected] of [['points', 4, '1'], ['sessions', 4, '2'], ['anim', 14, '4']]) { // Combined fixture totals: 3+1 points/sessions and 10+4 frames.
      await page.goto(`${base}?metric=${metric}&pool=combined&teams=Alpha&duration=all`);
      await ready(page);
      await page.locator('#fit-highlighted').click();
      const fitted = await bounds(page);
      await toggle(page, 'remaining').click();
      assert.deepEqual(await bounds(page), [maximum - fitted[1], maximum - fitted[0]]);
      assert.ok((await page.locator('#chart-title').textContent()).endsWith('remaining'));
      assert.equal((await hoverLatest(page)).Alpha, expected);
      await toggle(page, 'matched').click();
      (await bounds(page)).forEach((v, i) => assert.ok(Math.abs(v - fitted[i]) < 1e-10)); // Only floating-point round-trip error is allowed.
    }
    // Timings keep the same chart and fixed interval even while the table switches.
    await page.goto(`${base}?metric=startup&teams=Alpha&duration=all`);
    await ready(page);
    await page.locator('#fit-highlighted').click();
    const speedBounds = await bounds(page);
    await toggle(page, 'remaining').click();
    assert.deepEqual(await bounds(page), speedBounds);
    assert.equal(await page.locator('#chart-title').textContent(), 'Startup time');
    assert.equal((await hoverLatest(page)).Alpha, '123 ms'); // The fixture's startup timing is independent of the display mode.

    // In remaining view, improving runs must tint green even though the number decreases.
    await page.goto(`${base}?display=remaining&teams=Alpha&duration=all`);
    await ready(page);
    assert.equal(await page.locator('#thead th[aria-sort]').getAttribute('aria-sort'), 'ascending', 'a remaining link defaults to fewest first');
    await page.locator('#st-first').click();
    await page.locator('#st-last').click();
    const improved = await page.locator('tr[data-team=Alpha] [data-score=points-combined]').evaluate(td => {
      const animation = td.getAnimations()[0];
      animation.pause();
      animation.currentTime = 0; // Sample the first, strongest tint instead of racing its fade.
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = getComputedStyle(td).backgroundColor;
      ctx.fillRect(0, 0, 1, 1); // One pixel is enough to normalize CSS color syntax to RGB.
      return [...ctx.getImageData(0, 0, 1, 1).data];
    });
    assert.ok(improved[1] > improved[0], 'a smaller remaining count renders green'); // Green's channel exceeds red for the improvement tint.

    // Empty and flat highlighted series must retain fit behavior in remaining mode.
    await page.goto(`${base}?metric=prng&display=remaining&teams=Missing`);
    await ready(page);
    assert.equal(await page.locator('#fit-highlighted').getAttribute('aria-disabled'), 'true');
    await page.goto(`${base}?metric=prng&display=remaining&teams=Perfect`);
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
    await page.goto(`${base}?metric=prng&display=invalid&teams=Alpha`);
    await ready(page);
    assert.equal(await page.locator('#display-matched').isChecked(), true, 'invalid mode uses matched');
    assert.deepEqual(errors, []);
    console.log('Global Remaining: delayed data, complemented fit, tooltips, pools, gaps, persistence, links, keyboard, selection and responsive layout passed.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
