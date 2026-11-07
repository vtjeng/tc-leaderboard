// Run against a served checkout with Playwright on NODE_PATH.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8765/';
const ready = page => page.waitForSelector('body:not(.loading):not(.load-failed)');
const rows = page => page.locator('#tbody tr').evaluateAll(rows => rows.map(tr => ({
  team: tr.dataset.team,
  rank: tr.querySelector('.rank').textContent,
  delta: tr.querySelector('.rank-delta').textContent,
  description: tr.querySelector('.rank-delta').getAttribute('aria-label'),
})));
const settled = page => page.waitForFunction(() => document.querySelector('#tbody').getAnimations({ subtree: true }).length === 0);

(async () => {
  const browser = await chromium.launch();
  try {
    // Desktop shows the chart and standings together; explicit teams avoids saved defaults.
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}?teams=vtjeng&duration=all`);
    await ready(page);
    const chart = page.locator('#svg');
    await chart.focus();
    await page.keyboard.press('ArrowLeft');
    await settled(page);
    const preceding = await rows(page);
    await page.keyboard.press('ArrowRight');
    const current = await rows(page);
    const oldRanks = new Map(preceding.map(r => [r.team, Number(r.rank)]));
    for (const row of current) {
      const prev = oldRanks.get(row.team);
      if (!row.rank || !prev) continue;
      const delta = prev - Number(row.rank);
      assert.equal(row.delta, delta === 0 ? '—' : `${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}`);
    }
    assert.equal(await chart.evaluate(el => el === document.activeElement), true);
    console.log('Real CSV: keyboard stepping, rank deltas, and chart focus passed.');

    // Three six-hourly runs after the scoring cutoff. Beta overtakes Alpha,
    // Gamma also passes Alpha, New enters, and Missing has no sortable score.
    const times = ['2026-10-01T00:00:00Z', '2026-10-01T06:00:00Z', '2026-10-01T12:00:00Z'];
    const scores = [
      [['Alpha', 90, 10], ['Beta', 70, 20], ['Gamma', 50, 10], ['Missing', '', '']],
      [['Alpha', 60, 10], ['Beta', 80, 20], ['Gamma', 65, 10], ['New', 50, 5], ['Missing', '', '']],
      [['Alpha', 100, 10], ['Beta', 80, 20], ['Gamma', 65, 10], ['Missing', '', '']],
    ];
    const csv = 'snapshot_ts,team,pub_points,held_points,pub_max_points,held_max_points\n' +
      scores.flatMap((run, i) => run.map(([team, pub, held]) =>
        `${times[i]},${team},${pub},${held},100,100` // Fixed maxima keep the chart scale comparable.
      )).join('\n');
    const fixture = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    fixture.on('pageerror', error => errors.push(error.message));
    let releaseData;
    const dataReady = new Promise(resolve => { releaseData = resolve; });
    await fixture.route('**/data/leaderboard.csv', async route => {
      await dataReady;
      await route.fulfill({ contentType: 'text/csv', body: csv });
    });
    await fixture.goto(`${base}?teams=Alpha&duration=all`);
    assert.equal(await fixture.locator('#tbody tr').count(), 0, 'delayed data keeps the loading state');
    releaseData();
    await ready(fixture);
    assert.equal(await fixture.locator('#tbody').evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'initial load does not animate');
    await fixture.locator('#svg').focus();
    await fixture.keyboard.press('Home');
    await settled(fixture);
    assert.ok((await rows(fixture)).every(r => r.delta === '—'), 'first run has no comparison');
    await fixture.keyboard.press('ArrowRight');
    const changed = await rows(fixture);
    assert.deepEqual(changed.map(r => [r.team, r.rank, r.delta]), [
      ['Beta', '1', '↑1'], // Passes Alpha.
      ['Gamma', '2', '↑1'], // Also passes Alpha.
      ['Alpha', '3', '↓2'], // Overtaken by both teams.
      ['New', '4', 'new'], // No rank in the preceding run.
      ['Missing', '', '—'], // Missing values never receive a rank or delta.
    ]);
    const animated = await fixture.locator('#tbody').evaluate(el => el.getAnimations({ subtree: true })
      .map(a => ({ team: a.effect.target.dataset.team, frames: a.effect.getKeyframes() })));
    assert.ok(animated.some(a => a.team === 'Beta' && a.frames[0].transform !== 'translateY(0)'), 'keyboard step animates the overtaking team');
    // Reverse synchronously during motion to compare the exact outgoing and incoming positions.
    const reversal = await fixture.evaluate(() => {
      const top = () => document.querySelector('#tbody tr[data-team="Beta"]').getBoundingClientRect().top;
      const before = top();
      document.querySelector('#svg').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      return Math.abs(top() - before);
    });
    assert.ok(reversal < 1, 'rapid reversal starts at the current visible position (subpixel tolerance)');
    await settled(fixture);
    await fixture.keyboard.press('ArrowRight');
    await settled(fixture);
    assert.deepEqual(await rows(fixture), changed, 'returning to a run restores the same deltas');
    const shared = fixture.url();
    await fixture.reload();
    await ready(fixture);
    assert.deepEqual(await rows(fixture), changed, 'shared run keeps its chronological comparison');

    // A row control retains focus after selecting a highlight.
    const beta = fixture.locator('#tbody tr[data-team="Beta"] .key');
    await beta.focus();
    await fixture.keyboard.press('Space');
    assert.equal(await beta.evaluate(el => el === document.activeElement), true);
    assert.equal(await beta.getAttribute('aria-pressed'), 'true');
    await fixture.locator('#thead button[data-key="points-combined"]').click();
    await settled(fixture);
    assert.equal(await fixture.locator('#thead button[data-key="points-combined"]').evaluate(el => el === document.activeElement), true);
    assert.equal((await rows(fixture)).find(r => r.team === 'Alpha').delta, '↑1', 'ascending order includes the entrant below Alpha');
    await fixture.locator('label:has(#pool-pub)').click();
    await settled(fixture);
    assert.equal((await rows(fixture)).find(r => r.team === 'Alpha').delta, '↑1', 'pool change compares both public rankings');

    // Reduced motion updates ranks immediately even when rows reorder.
    await fixture.emulateMedia({ reducedMotion: 'reduce' });
    await fixture.locator('#svg').focus();
    await fixture.keyboard.press('ArrowLeft');
    assert.equal(await fixture.locator('#tbody').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await fixture.keyboard.press('ArrowRight');
    assert.equal(await fixture.locator('#tbody').evaluate(el => el.getAnimations({ subtree: true }).length), 0);

    // Phone sizes, landscape, and intermediate widths exercise horizontal table scrolling.
    for (const [width, height] of [[320, 568], [390, 664], [390, 844], [640, 800], [844, 390], [900, 800]]) {
      await fixture.setViewportSize({ width, height });
      await fixture.waitForFunction(() => document.querySelector('#svg').getAttribute('width') ===
        String(Math.max(280, document.querySelector('#chart').clientWidth)));
      assert.equal(await fixture.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await fixture.goto(shared);
    await ready(fixture);
    // Keep the chart focused while viewing the standings farther down the page.
    await fixture.locator('#svg').focus();
    // Leave room below the table: a departing entrant shortens the document,
    // and the browser must clamp scroll positions beyond its new bottom.
    await fixture.evaluate(() => window.scrollTo(0, document.querySelector('.standings').offsetTop - innerHeight / 3));
    const scroll = await fixture.evaluate(() => scrollY);
    await fixture.keyboard.press('ArrowLeft');
    assert.equal(await fixture.evaluate(() => scrollY), scroll, 'keyboard stepping preserves scroll');
    assert.equal(await fixture.locator('#svg').evaluate(el => el === document.activeElement), true);
    assert.deepEqual(errors, []);
    console.log('Fixture: movement, interruption, first run, entrants, missing scores, sort, pools, selection focus, delayed data, shared links, reduced motion, resizing, and scroll passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
