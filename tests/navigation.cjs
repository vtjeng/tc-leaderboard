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
    // Reproduce the reported July runs in PDT: startup time loses a digit.
    const widths = await browser.newPage({ locale: 'en-US', timezoneId: 'America/Los_Angeles' });
    await widths.goto(`${base}?teams=&duration=all&as_of=2026-07-14T03:37Z`);
    await ready(widths);
    await widths.evaluate(() => document.fonts.ready);
    // Desktop and phone cover both stretched and horizontally scrolling tables.
    for (const width of [1280, 390]) {
      await widths.setViewportSize({ width, height: 900 });
      const columns = () => widths.locator('#thead th').evaluateAll(cells => cells.map(cell => {
        const { x, width } = cell.getBoundingClientRect();
        return { x, width };
      }));
      const before = await columns();
      assert.match(await shown(widths), /8:36 PM PDT/);
      await widths.locator('#st-next').click();
      assert.match(await shown(widths), /10:27 PM PDT/);
      assert.deepEqual(await columns(), before, 'column boundaries hold when startup time changes from four digits to three');
      await widths.locator('#st-prev').click();
      assert.deepEqual(await columns(), before, 'reverse navigation preserves the same column boundaries');
    }
    await widths.close();

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
    const start = page.getByRole('button', { name: 'First scoring run', exact: true });
    const end = page.getByRole('button', { name: 'Last scoring run', exact: true });
    const play = page.locator('#st-play');
    assert.equal(await prev.count(), 1, 'standings exposes a named previous button');
    assert.equal(await next.count(), 1, 'standings exposes a named next button');
    assert.equal(await prev.isDisabled(), true, 'navigation waits for data');
    assert.equal(await next.isDisabled(), true);
    assert.equal(await play.isDisabled(), true, 'playback also waits for data');
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
    await start.click();
    assert.equal(await shown(page), first, 'start button reaches the first window run');
    assert.equal(await start.getAttribute('aria-disabled'), 'true');
    await play.focus();
    await page.keyboard.press('Space');
    assert.equal(await play.getAttribute('aria-label'), 'Pause scoring runs');
    // Two automatic steps traverse the three-run fixture and pause at its end.
    await page.waitForFunction(expected => document.querySelector('#st-time').textContent === expected, middle);
    await page.waitForFunction(() => document.querySelector('#st-play').getAttribute('aria-pressed') === 'false');
    assert.equal(await shown(page), latest, 'playback stops at the last run');
    assert.equal(await play.evaluate(el => el === document.activeElement), true, 'playback retains its control focus');
    await play.click();
    assert.equal(await shown(page), first, 'playing at the end restarts from the first run');
    await play.click();
    assert.equal(await play.getAttribute('aria-pressed'), 'false', 'play button also pauses');
    await play.click();
    await next.click();
    assert.equal(await play.getAttribute('aria-pressed'), 'false', 'manual navigation pauses playback');
    // Longer than one 800 ms playback interval, to catch an uncancelled timer.
    await page.waitForTimeout(1000);
    assert.equal(await shown(page), middle, 'paused playback cannot advance later');
    await end.click();
    assert.equal(await shown(page), latest, 'end button reaches the last window run');
    assert.equal(await end.getAttribute('aria-disabled'), 'true');
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
      assert.ok(nav.x >= title.x + title.width || nav.y >= title.y + title.height, 'controls wrap as one group without overlapping the title');
      const head = await page.locator('.st-head').boundingBox();
      assert.ok(Math.abs(nav.x + nav.width - head.x - head.width) < 1, 'controls remain aligned to the right edge'); // Subpixel rounding tolerance.
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
    await play.click();
    assert.equal(await shown(page), first, 'frozen-window playback restarts at that window\'s first run');
    await page.waitForFunction(() => document.querySelector('#st-play').getAttribute('aria-pressed') === 'false');
    assert.equal(await shown(page), middle, 'playback stops at the frozen window end');
    assert.deepEqual(errors, []);
    console.log('Navigation: stable July column widths, delayed loading, click/keyboard stepping, endpoints, playback, held-key motion, green/red cell tints, table focus, scroll, reduced motion, responsive controls, and frozen windows passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
