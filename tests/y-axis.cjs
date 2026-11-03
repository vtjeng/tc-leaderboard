// Run against a locally served checkout with Playwright on NODE_PATH.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8765/';
const range = page => new URL(page.url()).searchParams.get('y_range');
const ticks = page => page.locator('#svg text[text-anchor="end"]').allTextContents();
const ready = page => page.waitForSelector('body:not(.loading):not(.load-failed)');

(async () => {
  const browser = await chromium.launch();
  try {
    // Desktop has room for all control groups in one row.
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // vtjeng has changing, nonzero scores; a week gives the overview room to pan.
    await page.goto(`${base}?teams=vtjeng&duration=7d`);
    await ready(page);
    const fit = page.locator('#fit-highlighted');
    const reset = page.locator('#reset-y');
    const frame = await page.locator('#svg').boundingBox();
    const overview = await page.locator('#mini').innerHTML();
    await fit.focus();
    await fit.press('Enter');
    const fitted = range(page);
    assert.ok(fitted, 'fit records fixed bounds');
    assert.ok(fitted.split(',').map(Number).every(Number.isFinite));
    assert.equal(await fit.evaluate(el => el === document.activeElement), true);
    assert.deepEqual(await page.locator('#svg').boundingBox(), frame, 'fit preserves the chart frame');
    assert.equal(await page.locator('#mini').innerHTML(), overview, 'fit leaves the overview unchanged');
    const fittedTicks = await ticks(page);
    const beforePan = await page.locator('#chart-sub').textContent();
    const selection = await page.locator('#mini .selection').boundingBox();
    // Drag by a quarter of the overview width, well past the click threshold.
    const mini = await page.locator('#mini').boundingBox();
    const startX = selection.x + selection.width / 2;
    const startY = selection.y + selection.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - mini.width / 4, startY, { steps: 8 });
    assert.deepEqual(await ticks(page), fittedTicks, 'scale holds during the drag');
    await page.mouse.up();
    assert.notEqual(await page.locator('#chart-sub').textContent(), beforePan);
    assert.equal(range(page), fitted);
    assert.deepEqual(await ticks(page), fittedTicks, 'scale holds after the drag');

    // Verify the fixed scale survives selection, hovering, and a viewport resize.
    await page.locator('#legend button').first().click();
    assert.equal(range(page), fitted);
    assert.equal(await fit.getAttribute('aria-disabled'), 'true');
    await fit.click({ force: true });
    assert.equal(range(page), fitted, 'empty selection cannot replace the bounds');
    await page.locator('#tbody tr').first().click();
    assert.equal(range(page), fitted);
    const plot = await page.locator('#svg').boundingBox();
    await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2);
    assert.equal(range(page), fitted);
    assert.ok(await page.locator('#svg [clip-path="url(#plot-clip)"] .hover').count());
    assert.equal(await page.locator('#svg path.line:not([clip-path])').evaluateAll(paths =>
      paths.every(path => path.closest('[clip-path="url(#plot-clip)"]') != null)), true);
    // Short and tall phones, narrow phones, landscape, and intermediate widths.
    for (const [width, height] of [[390, 664], [390, 844], [320, 568], [844, 390], [640, 800], [900, 800]]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => document.querySelector('#svg').getAttribute('width') ===
        String(Math.max(280, document.querySelector('#chart').clientWidth)));
      assert.equal(range(page), fitted);
      assert.deepEqual(await ticks(page), fittedTicks);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    const shared = page.url();
    await page.reload();
    await ready(page);
    assert.equal(range(page), fitted, 'reload preserves fixed bounds');
    await page.goto(base);
    await ready(page);
    assert.equal(range(page), fitted, 'bare URL restores saved bounds');
    const fresh = await browser.newPage();
    await fresh.goto(shared);
    await ready(fresh);
    assert.equal(range(fresh), fitted, 'shared link works without local storage');
    await fresh.close();

    await fit.click();
    assert.notEqual(range(page), fitted, 'refit uses the new window and highlights');
    await reset.focus();
    await reset.press('Space');
    assert.equal(range(page), null);
    assert.equal(await reset.evaluate(el => el === document.activeElement), true);
    await fit.click();
    await page.locator('label:has(#metric-prng)').click();
    assert.equal(range(page), null, 'metric changes reset the scale');
    await fit.click();
    await page.locator('label:has(#pool-pub)').click();
    assert.equal(range(page), null, 'pool changes reset the scale');

    // Invalid bounds must not produce a broken or reversed axis.
    for (const invalid of ['10,10', '20,10', ',10', 'NaN,10', '0,Infinity']) {
      await page.goto(`${base}?teams=vtjeng&y_range=${invalid}`);
      await ready(page);
      assert.equal(range(page), null);
    }
    assert.deepEqual(errors, []);
    console.log('Real CSV: fixed scaling, drag, selection, resize, keyboard, persistence, reset and invalid links passed.');

    // Two runs after the scoring cutoff: flat, zero, missing, and bounded percentage data.
    const context = await browser.newContext();
    const edge = await context.newPage();
    const edgeErrors = [];
    edge.on('pageerror', error => edgeErrors.push(error.message));
    let releaseData;
    const dataReady = new Promise(resolve => { releaseData = resolve; });
    const csv = 'snapshot_ts,team,pub_points,held_points,pub_rng_pct,pub_max_points,held_max_points\n' +
      ['2026-10-01T00:00:00Z', '2026-10-01T06:00:00Z'].flatMap(t => [
        `${t},flat,100,0,100,100,0`, // Positive flat line and PRNG at its upper bound.
        `${t},zero,0,0,0,100,0`, // Zero needs a non-degenerate domain.
        `${t},missing,,,,,`, // Known team without any usable metric values.
      ]).join('\n');
    await edge.route('**/data/leaderboard.csv', async route => {
      await dataReady;
      await route.fulfill({ contentType: 'text/csv', body: csv });
    });
    await edge.goto(`${base}?teams=flat`);
    assert.equal(await edge.locator('#fit-highlighted').isDisabled(), true, 'fit waits for data');
    releaseData();
    await ready(edge);
    for (const team of ['flat', 'zero']) {
      await edge.goto(`${base}?teams=${team}`);
      await ready(edge);
      await edge.locator('#fit-highlighted').click();
      const [lo, hi] = range(edge).split(',').map(Number);
      assert.ok(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo);
      await edge.locator('label:has(#metric-prng)').click();
      await edge.locator('#fit-highlighted').click();
      const percent = range(edge).split(',').map(Number);
      assert.ok(percent[0] >= 0 && percent[1] <= 100 && percent[0] < percent[1]); // PRNG's natural bounds.
    }
    await edge.goto(`${base}?teams=missing`);
    await ready(edge);
    assert.equal(await edge.locator('#fit-highlighted').getAttribute('aria-disabled'), 'true');
    await edge.locator('#fit-highlighted').click({ force: true });
    assert.equal(range(edge), null);
    assert.deepEqual(edgeErrors, []);
    await context.close();
    console.log('Intercepted CSV: delayed loading, flat, zero, missing and percentage edge cases passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
