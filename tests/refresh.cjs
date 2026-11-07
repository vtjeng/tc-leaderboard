// Run with Playwright on NODE_PATH. A real HTTP server exercises browser caching.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { chromium } = require('playwright');

// Six-hourly runs after the scoring cutoff; later runs arrive during the test.
const times = ['2026-10-01T00:00:00.000Z', '2026-10-01T06:00:00.000Z', '2026-10-01T12:00:00.000Z', '2026-10-01T18:00:00.000Z'];
// Start with two runs so keyboard navigation can pin an earlier one.
let runCount = 2;
let fail = false;
const requests = [];
const csv = () => 'snapshot_ts,team,pub_points,held_points,pub_max_points,held_max_points\n' +
  times.slice(0, runCount).flatMap(t => [
    `${t},Alpha,90,10,100,100`, // Alpha leads in every run so only the data's arrival changes.
    `${t},Beta,70,20,100,100`,
  ]).join('\n');
const server = createServer(async (req, res) => {
  if (req.url === '/data/leaderboard.csv') {
    const etag = `"runs-${runCount}"`;
    const status = fail ? 503 : req.headers['if-none-match'] === etag ? 304 : 200;
    requests.push({ status, validator: req.headers['if-none-match'] });
    res.writeHead(status, { 'Content-Type': 'text/csv', 'Cache-Control': 'public, max-age=300', ETag: etag });
    res.end(status === 200 ? csv() : undefined);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(readFileSync(join(__dirname, '..', 'index.html')));
  }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  try {
    // Desktop keeps chart and standings in view while checking focus and layout.
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Start at the initial latest run, then advance the clock to exercise polling.
    const initialTime = new Date(times[1]);
    await page.clock.install({ time: initialTime });
    await page.goto(`http://127.0.0.1:${server.address().port}/?teams=Alpha&duration=all&y_range=0,250`);
    await page.waitForSelector('body:not(.loading):not(.load-failed)');
    assert.equal(requests.at(-1).status, 200, 'cold load downloads the CSV');

    // Five minutes reaches the first automatic refresh, well short of the old hour.
    const interval = 5 * 60 * 1000;
    let response = page.waitForResponse(r => r.url().endsWith('/data/leaderboard.csv'));
    await page.clock.fastForward(interval);
    await response;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(requests.at(-1).status, 304, 'unchanged data revalidates without a body');
    assert.ok(requests.at(-1).validator, 'the browser sends the cached ETag');

    // A third run arrives while focus and visibility events overlap.
    runCount = 3;
    const before = requests.length;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(t => document.querySelector('#latest-run').dateTime === t, times[2]);
    assert.equal(requests.length, before + 1, 'overlapping return events share one refresh');
    assert.equal(new URL(page.url()).searchParams.get('y_range'), '0,250', 'new data preserves fixed bounds');
    assert.equal(new URL(page.url()).searchParams.get('teams'), 'Alpha', 'new data preserves highlights');

    // Pin the previous run, then preserve it while the newest run arrives.
    await page.locator('#svg').focus();
    await page.keyboard.press('ArrowLeft');
    const pinned = await page.locator('#st-time').textContent();
    const highlight = page.locator('#tbody tr[data-team="Alpha"] .key');
    await highlight.focus();
    const frame = await page.locator('#svg').boundingBox();
    const scroll = await page.evaluate(() => scrollY);
    runCount = 4;
    await page.clock.fastForward(interval);
    await page.waitForFunction(t => document.querySelector('#latest-run').dateTime === t, times[3]);
    assert.equal(await page.locator('#st-time').textContent(), pinned, 'refresh preserves a pinned run');
    assert.equal(await highlight.evaluate(el => el === document.activeElement), true, 'refresh preserves keyboard focus');
    assert.equal(await page.evaluate(() => scrollY), scroll, 'refresh preserves scroll');
    assert.deepEqual(await page.locator('#svg').boundingBox(), frame, 'refresh preserves the chart frame');

    // An unavailable source keeps the existing view and retries on the next return.
    fail = true;
    response = page.waitForResponse(r => r.url().endsWith('/data/leaderboard.csv'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await response;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(requests.at(-1).status, 503, 'the source failure reaches the browser');
    assert.equal(await page.locator('#st-time').textContent(), pinned, 'a failure retains loaded data');
    fail = false;
    response = page.waitForResponse(r => r.url().endsWith('/data/leaderboard.csv'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await response;
    // The failed response can evict the cached CSV, so recovery downloads it again.
    assert.equal(requests.at(-1).status, 200, 'a failed refresh does not block later retries');
    assert.deepEqual(errors, []);
    console.log('HTTP CSV: conditional caching, five-minute polling, return events, overlapping requests, pinned state, focus, layout, and failure recovery passed.');
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
