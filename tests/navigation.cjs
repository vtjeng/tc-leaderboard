// Run against a served checkout with Playwright on NODE_PATH.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8765/';
const ready = page => page.waitForSelector('body:not(.loading):not(.load-failed)');
const settled = page => page.waitForFunction(() => document.querySelector('#tbody').getAnimations({ subtree: true }).length === 0);
const shown = page => page.locator('#st-time').textContent();

(async () => {
  const browser = await chromium.launch();
  try {
    // Desktop fits both the standings title and the two navigation buttons.
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // Three runs after the scoring cutoff, with Alpha and Beta swapping at each step.
    const times = ['2026-10-01T00:00:00Z', '2026-10-01T06:00:00Z', '2026-10-01T12:00:00Z'];
    const csv = 'snapshot_ts,team,pub_points,held_points,pub_max_points,held_max_points,pub_rng_pct,held_rng_pct,pub_passing,held_passing,pub_anim_matched,held_anim_matched\n' +
      times.flatMap((t, i) => [
        `${t},Alpha,${i === 1 ? 50 : 90},0,400,0,80,0,3,0,100,0`, // Alpha loses and regains its place above Beta.
        `${t},Beta,70,0,400,0,80,0,3,0,100,0`, // Beta's fixed values produce overtakes without cell tints.
        `${t},Stable,${i === 1 ? 310 : 300},0,400,0,${i === 1 ? 81 : 80},0,${i === 1 ? 4 : 3},0,${i === 1 ? 110 : 100},0`, // All four metrics change while rank stays first.
      ]).join('\n');
    let release;
    const dataReady = new Promise(resolve => { release = resolve; });
    await page.route('**/data/leaderboard.csv', async route => {
      await dataReady;
      await route.fulfill({ contentType: 'text/csv', body: csv });
    });
    await page.goto(`${base}?teams=Alpha&duration=all`);
    const prev = page.getByRole('button', { name: 'Previous scoring run', exact: true });
    const next = page.getByRole('button', { name: 'Next scoring run', exact: true });
    assert.equal(await prev.count(), 1, 'standings exposes a named previous button');
    assert.equal(await next.count(), 1, 'standings exposes a named next button');
    assert.equal(await prev.isDisabled(), true, 'navigation waits for data');
    assert.equal(await next.isDisabled(), true);
    release();
    await ready(page);
    assert.equal(await page.locator('#tbody').evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'initial load stays neutral');
    const latest = await shown(page);
    assert.equal(await next.getAttribute('aria-disabled'), 'true', 'latest run has no successor');
    await prev.click();
    const middle = await shown(page);
    assert.notEqual(middle, latest);
    const tints = await page.locator('#tbody').evaluate(el => el.getAnimations({ subtree: true })
      .filter(a => a.effect.target.matches('td[data-score]'))
      .map(a => ({ team: a.effect.target.closest('tr').dataset.team, metric: a.effect.target.dataset.score, title: a.effect.target.title })));
    assert.equal(tints.filter(t => t.team === 'Stable' && t.title.startsWith('Score increase')).length, 4, 'all four improving metrics tint without a rank change');
    assert.equal(tints.filter(t => t.team === 'Beta').length, 0, 'unchanged values stay neutral');
    assert.ok(tints.some(t => t.team === 'Alpha' && t.title.startsWith('Score decrease')), 'falling points receive the decrease cue');
    // Sample the rendered color through canvas so both RGB and color(srgb) CSS forms work.
    const tint = async team => page.locator(`#tbody tr[data-team="${team}"] [data-score="points-combined"]`).evaluate(td => {
      const context = document.createElement('canvas').getContext('2d');
      context.fillStyle = getComputedStyle(td).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    });
    const green = await tint('Stable');
    const red = await tint('Alpha');
    assert.ok(green[1] > green[0], 'an increase renders green');
    assert.ok(red[0] > red[1], 'a decrease renders red');
    await settled(page);
    assert.equal(await prev.evaluate(el => el === document.activeElement), true);
    await next.click();
    assert.equal(await shown(page), latest, 'pointer controls reach the same run in both directions');
    assert.ok((await page.locator('#tbody tr[data-team="Stable"] [data-score="points-combined"]').getAttribute('title')).startsWith('Score decrease'), 'reversing the step reverses the tint');
    await settled(page);
    await next.click({ force: true });
    assert.equal(await shown(page), latest, 'clicking an unavailable direction does nothing');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await shown(page), middle, 'an unavailable next button still supports reversing with the keyboard');
    await settled(page);
    await page.keyboard.press('Home');
    await settled(page);
    const first = await shown(page);
    assert.notEqual(first, middle);
    assert.equal(await prev.getAttribute('aria-disabled'), 'true');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await shown(page), first, 'first-run boundary stays put');

    // Keep the key down: repeated keydown events wait for each row movement.
    await page.keyboard.down('ArrowRight');
    assert.equal(await shown(page), middle);
    assert.ok(await page.locator('#tbody').evaluate(el => el.getAnimations({ subtree: true }).length > 0));
    await page.keyboard.down('ArrowRight');
    assert.equal(await shown(page), middle, 'held-key repeat cannot interrupt a moving row');
    await settled(page);
    await page.keyboard.down('ArrowRight');
    assert.equal(await shown(page), latest, 'held-key repeat advances once movement finishes');
    await page.keyboard.up('ArrowRight');
    await settled(page);
    await page.keyboard.press('Escape');
    assert.equal(await shown(page), latest, 'Escape restores the window end');

    // Arrow keys work from the table and its row controls, preserving focus and scroll.
    await page.locator('.standings').focus();
    await page.evaluate(() => scrollTo(0, document.querySelector('.standings').offsetTop - innerHeight / 3));
    const scroll = await page.evaluate(() => scrollY);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await shown(page), middle);
    assert.equal(await page.evaluate(() => scrollY), scroll);
    await settled(page);
    const rowControl = page.locator('#tbody tr[data-team="Alpha"] .key');
    await rowControl.focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await shown(page), first);
    assert.equal(await rowControl.evaluate(el => el === document.activeElement), true);
    await settled(page);
    await page.keyboard.press('End');
    assert.equal(await shown(page), latest);
    await settled(page);
    assert.deepEqual(errors, []);

    // Reduced motion permits fast repeats because no row is still moving.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await prev.focus();
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.up('ArrowLeft');
    assert.equal(await shown(page), first);

    // Narrow/tall/landscape phones and intermediate widths retain top-right controls.
    for (const [width, height] of [[320, 568], [390, 664], [390, 844], [640, 800], [844, 390], [900, 800]]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => document.querySelector('#svg').getAttribute('width') ===
        String(Math.max(280, document.querySelector('#chart').clientWidth)));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const title = await page.locator('#st-title').boundingBox();
      const nav = await page.locator('.st-nav').boundingBox();
      assert.ok(nav.x >= title.x + title.width, 'controls remain to the right of the wrapped title');
      assert.equal((await prev.boundingBox()).height, (await next.boundingBox()).height);
    }
    // A linked run beyond a frozen six-hour window must step into its end.
    await page.goto(`${base}?teams=Alpha&duration=6h&utc_end=2026-10-01T06:00Z&as_of=2026-10-01T12:00Z`);
    await ready(page);
    assert.equal(await shown(page), latest);
    await prev.click();
    assert.equal(await shown(page), middle, 'outside run steps into the nearer window edge');
    assert.equal(await next.getAttribute('aria-disabled'), 'true', 'frozen-window end is a navigation boundary');
    await prev.click();
    assert.equal(await shown(page), first);
    await page.keyboard.press('Escape');
    assert.equal(await shown(page), middle, 'Escape restores the frozen window end');
    console.log('Navigation: delayed loading, click/keyboard stepping, endpoints, held-key motion, green/red cell tints, table focus, scroll, reduced motion, responsive controls, and frozen windows passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
