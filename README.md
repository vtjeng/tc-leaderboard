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
every hour and commits the CSV when a new run has arrived.

## Dashboard

`index.html` loads the CSV and charts one metric per team over time. The same
workflow deploys it to <https://vtjeng.github.io/tc-leaderboard/> on every data
update and every push to `main`. To view it locally, serve this folder over
HTTP and open <http://localhost:8000/>:

```sh
python3 -m http.server
```
