# tc-leaderboard

This repository keeps the scoring history of the
[Teleport Coding Challenge leaderboard](https://mazesofmenace.ai/leaderboard/)
and a dashboard that charts it.

## Data

`data/leaderboard.csv` has one row per team per scoring run. The contest judge
commits `leaderboard/data.json` to
[davidbau/mazesofmenace](https://github.com/davidbau/mazesofmenace) about every
six hours, and each commit is one run. `update_data.py` rebuilds the CSV from
every version of that file:

```sh
python3 update_data.py
```

The script needs Python 3 and git, and nothing else. It makes a temporary
blobless clone of the upstream repository and fetches every version of
`data.json` in one request. It keeps no state between runs, so a missed run
loses no data. A full rebuild took 11 seconds on 2026-09-29.

The CSV stores the fields the leaderboard computes its columns from:

- `snapshot_ts` is the run's `timestamp`; `commit` is the upstream commit.
- `pub_*` and `held_*` cover the public and held-out pools of 44 sessions each:
  points, maximum points, sessions passed and total, PRNG and screen match
  percentages, and animation frames.
- `speed_*` holds the judge's linear speed fit, and `playable` through
  `threshold_ms_per_move` hold its browser playability check.
- `category` falls back to `leaderboard/grandfathered.json` at the same commit,
  as the leaderboard does.
- `scoring_error` is set when the judge could not score the fork in that run;
  the row then carries the fork's last good numbers.

Floats are rounded to four decimal places. A field is empty in runs from before
the judge added it.

A GitHub Actions workflow, `.github/workflows/update.yml`, runs the script
every 15 minutes and commits the CSV when a new run has arrived. GitHub runs
scheduled workflows on a best-effort basis and sometimes skips them; to update
immediately, run `gh workflow run update.yml`.

## Dashboard

`index.html` loads the CSV and charts one metric per team over time. Cloudflare
Workers Builds deploys it to <https://tc-leaderboard.vtjeng.com/> on every push
to `main`, data updates included (`wrangler.toml`). The Worker serves only the
files `.assetsignore` allows, so a new file the page loads must be added there.
To view it locally, serve this folder over HTTP and open
<http://localhost:8000/>:

```sh
python3 -m http.server
```

The page remembers each reader's view in local storage and also mirrors it in
the address bar, so a copied link reproduces the view:

- `as_of`: the standings as of this time (UTC, to the minute): the last run at
  or before it, held as new runs arrive. Absent, the standings follow the
  latest run. A window dragged back from the latest run fills it in with the
  window's end, and one made live again clears it; a run the reader picked
  stays. It need not be inside the chart window.
- `duration`: the chart window's length, such as `7d`, `36h`, `3d4h13m` or
  `all` (absent: `30d`).
- `utc_end`: where the window ends (absent: live, ending at the latest run).
- `y_range`: fixed Y-axis bounds as `minimum,maximum` (absent: automatic).
  **Fit highlighted** fits the highlighted teams in the current time window
  with padding, then holds those bounds as the window or highlights change.
  Values outside the bounds are clipped. Click it again to refit;
  **Reset Y-axis**, or changing the metric or pool, restores automatic scaling.
- `teams`: highlighted teams by colour; entry N is colour N, empty where that
  colour is free, so a link shows the same colours.
- `metric`, `pool` (`combined`, `public`, `holdout`), `sort` (a table column:
  `team`, `speed`, `playable` or a score and pool such as `points-public`) and
  `dir` (`asc` or `desc`).

`teams` is always present; the other parameters are left out at their
defaults, and `dir` when it is the column's usual direction. A link with parameters sets the whole view; only a bare link, such as
the site's own address, restores the reader's saved view. Other parameters a
shared link picks up (`utm_source`, `fbclid`) are left as they are.

## Browser checks

The standings have first, previous, play/pause, next, and last controls at the
top right. Click them, or focus the standings or chart and use the arrow keys,
to step through runs in the chart window. Home and End jump to its first and
last run; Escape restores the window's resting run. An unavailable direction
stays focusable so you can reverse with the keyboard.

Play advances one run every 800 ms and pauses at the window's end. Playing from
the end restarts at the first run. Manual navigation, changing the window,
metric, pool, or sort, and hiding the browser tab pause playback. The speed
column reserves room for the startup + per-move expression, so changing a
startup value from four digits to three does not shift the column boundaries.

Rows move as opaque blocks. Holding an arrow waits for each visual change to
finish; fresh presses can reverse immediately. Changed points, PRNG, sessions,
and animation matches briefly tint green for increases and red for decreases
relative to the outgoing view, including when ranks stay the same. Initial
loads, unchanged displayed values, missing values, and pool switches stay
neutral. Reduced-motion preferences skip movement and fading.

The Δ column compares each team's rank with the preceding
scoring run, using the current sort direction and pool. `new` means the team had
no rank in that order in the preceding run; a dash means unchanged, unranked, or
no preceding run. The comparison stays the same when you return to a run or
share its link.

`tests/y-axis.cjs` exercises fitting, dragging the time window, resetting,
keyboard controls, responsive layouts, and saved and shared bounds against
the served CSV. It also intercepts the CSV request to test delayed loading,
flat and missing values, zeroes, and percentage limits.

With the local server running and Playwright's Chromium installed, run the
following, setting `NODE_PATH` to the directory containing the `playwright`
package:

```sh
NODE_PATH=/path/to/node_modules node tests/y-axis.cjs http://localhost:8000/
NODE_PATH=/path/to/node_modules node tests/standings.cjs http://localhost:8000/
NODE_PATH=/path/to/node_modules node tests/navigation.cjs http://localhost:8000/
```

`tests/standings.cjs` checks keyboard stepping and rank changes against the served
CSV. An intercepted CSV provides overtakes, an entering team, and missing scores
to check animation, rapid reversals, sort and pool changes, focus, shared links,
reduced motion, and responsive layouts.

`tests/navigation.cjs` uses controlled scoring runs to check the table's arrow
buttons, keyboard navigation, endpoints, playback, held-key pacing, green/red
cell tints, unchanged ranks and scores, focus, scroll, and responsive button
placement. The reported July 13 runs verify stable column widths on desktop
and phone layouts when startup time changes from four digits to three.
