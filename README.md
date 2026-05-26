# Faction War Tracker

Live enemy-faction status dashboard for Torn ranked wars. Standalone web app — no
build step, no backend (Firebase only for optional shared claiming).

## What it shows

Six live buckets of the current enemy faction's roster, refreshed every 15s:

- **Online** — `last_action.status === "Online"`, newest activity first.
- **Active ≤ 5m** — went offline/idle within the last 5 minutes.
- **Hospital** — sorted by time-until-out, with a 1-second countdown and an
  optional browser notification when a member has &le; 2m remaining.
- **Hittable (Okay)** — everyone else flagged Okay, filterable by level.
- **Away** — Traveling / Abroad / Jail / Federal.
- **Inactive ≥ 24h** — no activity in the last 24 hours (overrides state-based
  bucketing so clearly-offline members don't pollute the Hospital/Hittable lists).

Each row links to the target's profile and a direct attack link.

The enemy faction is auto-detected from your faction's active ranked war
(`/v2/faction/wars`). You can also override with a manual faction ID for
scouting or chain prep outside wartime.

## Running

Live deployment: **<https://sultangris.github.io/torn-war-tracker/>**

The source is mirrored to the
[`torn-war-tracker`](https://github.com/sultangris/torn-war-tracker) repo by a
GitHub Action on every push to `main` that touches this folder (see
`.github/workflows/sync-war-tracker.yml`).

For local development (`http://localhost:8081`):

```bash
cd web-apps/faction-war-tracker
npm start
```

`file://` is no longer supported — the Firebase API key is now
referrer-restricted to the GitHub Pages and localhost origins.

Open the page, paste your Torn API key, and the dashboard starts polling.
The Settings modal includes a one-click link to create a **scoped Custom key**
with only the selections this app needs (`user:basic` + `faction:basic,wars,members`).

The key lives only in `localStorage` and is sent only to `api.torn.com`.

## Picking the enemy faction

By default the tracker auto-detects the current ranked-war opponent via
`/v2/faction/wars`. When you're not at war, or auto-detect picks the wrong
faction, type a faction ID into the **Track faction ID** field in the top
bar and press **Track**. The override persists in `localStorage`. Press the
**Auto** button (appears while a manual ID is active) to resume war
auto-detection.

## Rate-limit math

Two endpoints polled per viewer:

- `/v2/faction/wars` every 60s
- `/v2/faction/{enemyId}/members` every 15s

That's ~5 req/min per viewer, well under Torn's ~100 req/min per-key cap.

Transient failures (Torn 504 timeouts, network drops, error codes 5/17, HTTP
5xx) are silenced — the red dot flips on but the last good data stays visible
and no banner is shown. Persistent errors still surface a banner.

## Target claiming (shared across faction)

Claiming lets hitters mark which target they're attacking so callers and other
hitters can avoid double-hits in realtime.

Shared state lives in a **Firebase Realtime Database** project — the
`firebaseConfig` object is committed to `firebase-config.js`. Web SDK configs
are not secrets; the security rules in the Firebase project gate writes by
**room code** instead. The rules in this project are:

```json
{ "rules": { "rooms": { "$roomCode": { ".read": true, ".write": true } } } }
```

**Usage:**

1. In the top bar, type a **room code** (e.g. `war-2026-05`) and press
   **Join**. Anyone who joins the same code sees the same claims. The first
   person to join writes the tracked faction into the room metadata; later
   joiners auto-pick that faction with no extra setup.
2. Click **Claim** on any member row to claim that target for 15 minutes.
   Other browsers in the same room see it within a second.
3. Click **Pin** to make a permanent claim that stays until you manually
   **Unpin** it — useful for callers reserving high-value targets across
   multiple chains.
4. Re-claiming resets the 15m timer; **Unclaim** releases it; another user's
   claim shows **Steal** (with a confirm).
5. Expired claims are filtered locally and lazily deleted from Firebase on the
   next write. Permanent claims never expire.

To use a different Firebase project (e.g. for a different faction), replace
`firebase-config.js` with your project's config.

## Limitations / not in v1

- **No caller-assigned targets.** Only self-claim. Caller-pushes-to-hitter
  could be added on top of the same data model later.
- **No Discord webhook for alerts.** Deferred — browser notifications cover the
  single-user case.
- **Claim griefing.** Anyone who knows the room code can claim/unclaim
  anything (including stealing pins). Rotate room codes between wars; don't
  post them publicly.
- **No persistent history.** Refreshing the page resets the "already alerted"
  set for hospital countdowns.
