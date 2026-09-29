#!/usr/bin/env python3
"""Rebuild data/leaderboard.csv from the full history of the Teleport leaderboard.

The leaderboard at https://mazesofmenace.ai/leaderboard/ renders
leaderboard/data.json from the davidbau/mazesofmenace repository, which the
contest judge commits to roughly every six hours. Every commit to that file is
one snapshot. This script makes a throwaway blobless clone, fetches every
version of data.json in one request, and writes one CSV row per
(snapshot, team). It keeps no state between runs, so a missed run loses nothing.
"""

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path

UPSTREAM = "https://github.com/davidbau/mazesofmenace"
DATA_PATH = "leaderboard/data.json"
GRANDFATHERED_PATH = "leaderboard/grandfathered.json"
OUT = Path(__file__).resolve().parent / "data" / "leaderboard.csv"

# Same order and fallback as resolveCategory() in the leaderboard page.
CATEGORIES = ("transpiled", "agentic", "other", "none")

POOL_FIELDS = [
    ("points", "points"),
    ("max_points", "maxPoints"),
    ("passing", "passing"),
    ("total", "total"),
    ("rng_pct", "rngPct"),
    ("rng_steps_pct", "rngStepsPct"),
    ("screen_pct", "screenPct"),
    ("anim_matched", "animMatched"),
    ("anim_total", "animTotal"),
]
SPEED_FIELDS = ["startup_ms", "per_move_ms", "r2", "sessions"]
PLAYABILITY_FIELDS = [
    "playable",
    "not_playable_reason",
    "browser_ok",
    "ms_per_move",
    "threshold_ms_per_move",
]

COLUMNS = (
    ["snapshot_ts", "commit", "contest_phase", "team", "fork", "category", "last_scored"]
    + [f"pub_{name}" for name, _ in POOL_FIELDS]
    + [f"held_{name}" for name, _ in POOL_FIELDS]
    + [f"speed_{name}" for name in SPEED_FIELDS]
    + PLAYABILITY_FIELDS
    + ["scoring_error"]
)


def git(repo, *args, stdin=None):
    return subprocess.run(
        ["git", "-C", repo, *args], input=stdin, capture_output=True, check=True
    ).stdout


def cell(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        # Percentages carry ~15 significant digits upstream; 4 decimals is
        # far below anything the leaderboard displays.
        return f"{value:.4f}".rstrip("0").rstrip(".")
    return value


def team_rows(snapshot, commit, grandfathered):
    for team in snapshot.get("teams") or []:
        category = team.get("category")
        if category not in CATEGORIES:
            category = "none"
        if category == "none" and grandfathered.get(team.get("name")) in CATEGORIES:
            category = grandfathered[team["name"]]
        pub = team.get("public") or {}
        held = team.get("heldOut") or {}
        speed = team.get("speed") or {}
        play = team.get("playability") or {}
        row = {
            "snapshot_ts": snapshot.get("timestamp"),
            "commit": commit[:12],
            "contest_phase": snapshot.get("contestPhase"),
            "team": team.get("name"),
            "fork": team.get("fork"),
            "category": category,
            "last_scored": team.get("lastScored"),
            "scoring_error": (team.get("scoringError") or {}).get("error"),
        }
        for name, key in POOL_FIELDS:
            row[f"pub_{name}"] = pub.get(key)
            row[f"held_{name}"] = held.get(key)
        for name in SPEED_FIELDS:
            row[f"speed_{name}"] = speed.get(name)
        for name in PLAYABILITY_FIELDS:
            row[name] = play.get(name)
        yield {k: cell(v) for k, v in row.items()}


def read_blobs(repo, specs):
    """Yield the contents of each `<commit>:<path>` spec, or None if absent."""
    proc = subprocess.Popen(
        ["git", "-C", repo, "cat-file", "--batch"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )
    for spec in specs:
        proc.stdin.write(spec.encode() + b"\n")
        proc.stdin.flush()
        header = proc.stdout.readline().split()
        if header[-1] == b"missing":
            yield None
            continue
        body = proc.stdout.read(int(header[2]))
        proc.stdout.read(1)  # trailing newline
        yield body
    proc.stdin.close()
    proc.wait()


def main():
    with tempfile.TemporaryDirectory() as tmp:
        repo = f"{tmp}/upstream.git"
        subprocess.run(
            ["git", "clone", "-q", "--bare", "--filter=blob:none", UPSTREAM, repo],
            check=True,
        )
        commits = git(repo, "log", "--reverse", "--format=%H", "--", DATA_PATH).decode().split()
        # A blobless clone fetches each missing blob in its own request when it
        # is read; asking for all of them up front takes one request instead.
        blobs = set(
            git(repo, "rev-parse", *(f"{c}:{DATA_PATH}" for c in commits)).decode().split()
        )
        for line in git(
            repo, "log", "--raw", "--no-abbrev", "--format=", "--", GRANDFATHERED_PATH
        ).decode().splitlines():
            blobs.add(line.split()[3])
        blobs.discard("0" * 40)
        git(
            repo,
            "-c", "fetch.negotiationAlgorithm=noop",
            "fetch", "-q", "--no-tags", "--no-write-fetch-head",
            "--filter=blob:none", "--stdin", "origin",
            stdin="\n".join(sorted(blobs)).encode(),
        )

        specs = [s for c in commits for s in (f"{c}:{DATA_PATH}", f"{c}:{GRANDFATHERED_PATH}")]
        contents = read_blobs(repo, specs)
        # Keyed by snapshot timestamp: when two commits carry the same
        # snapshot, the later commit wins.
        snapshots = {}
        for commit in commits:
            snapshot = json.loads(next(contents))
            grandfathered_raw = next(contents)
            grandfathered = json.loads(grandfathered_raw) if grandfathered_raw else {}
            snapshots[snapshot.get("timestamp")] = list(team_rows(snapshot, commit, grandfathered))

    rows = [row for team_rows_ in snapshots.values() for row in team_rows_]
    rows.sort(key=lambda r: (r["snapshot_ts"], r["team"].lower()))
    OUT.parent.mkdir(exist_ok=True)
    with OUT.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    print(f"{len(snapshots)} snapshots, {len(rows)} rows -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
