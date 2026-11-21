# `improvements` branch: what changed and why

Branched from `main` after `new-scheduler` was merged in (`24b0837`). This branch is **not merged into `main`**. Review it, then open a PR when you're ready.

## TL;DR

- **Bug fixes:** removing a stop, transit outages, lunch timing, the cache, timezones, budget math.
- **Fewer false errors:** the scheduler and checker now separate *fixed starts* from *"not before" holds*. On the Boston sample, the first real-transit check went from 3 false errors to 0.
- **Real-time rescheduling:** when the real transit check fails, the plan is rearranged once using the travel times actually measured. Dropping a stop is now the last resort.
- **Lower Claude cost:** effort now defaults to `low`, the model is configurable, the tool list stays stable so prompts cache, and every run logs its tokens and cost.
- **New map:** easier to read and interactive (click, hover, step through a day). The itinerary list is linked to it.
- **Tests:** there's now a vitest suite (38 tests). Run `npm test`.

## How to try it

```bash
npm install
npm test          # 38 unit tests, no network needed
npm run dev       # then click "dev: boston sample" (no Claude call), then "dev: reschedule"
```

To run a real plan, copy `.env.local.example` to `.env.local` and set `ANTHROPIC_API_KEY`. Look at the end of the log for the line `run total (...)`: it shows tokens and an approximate $ cost.

## New settings (all optional, see `.env.local.example`)

| Variable | Default | What it does |
|---|---|---|
| `PLANNER_MODEL` | `claude-opus-5-5` | Model used by the planner (e.g. `claude-sonnet-5-5` to compare) |
| `PLANNER_EFFORT` | `low` | `low` / `medium` / `high` / `xhigh` / `max` |
| `PLAN_RUNS_PER_HOUR`, `PLAN_MAX_CONCURRENT` | 10, 3 | Per-visitor and at-once limits for `/api/plan` |
| `CHECK_RUNS_PER_HOUR`, `CHECK_MAX_CONCURRENT` | 120, 6 | Same, for `/api/check` |
| `CACHE_DIR` | `.cache` | Where API responses are cached |

## Changes in detail

### 1. Bugs fixed

| Problem | Fix | Where |
|---|---|---|
| "Remove" deleted two stops when a meal was held at a sight (they share a `place_id`) | Stops are removed by their position in the day. `TimedStop` now has an `index` field. | `app/page.tsx`, `lib/types.ts`, `lib/checker.ts` |
| A Transitous outage looked like an impossible plan, and `verify` then dropped sights | A failed lookup is now a `lookup_failed` **warning** with an estimated leg. It never causes an error or a drop. | `lib/checker.ts` |
| `verify` found stops by parsing error text (`message.split(":")`) | Every `Issue` carries a `placeId`, and issue codes are a typed union `IssueCode` | `lib/types.ts`, `lib/verify.ts` |
| Scheduler allowed lunch until 15:00 but `LUNCH.to` was 14:00; the checker never checked lunch | One rule in `rules.ts` (`LUNCH_EARLIEST` / `LUNCH_LATEST`). The scheduler orders the day around lunch, and the checker adds a `lunch_time` warning. | `lib/rules.ts`, `lib/scheduler.ts`, `lib/checker.ts` |
| The cache never expired, and crashed on read-only disks (serverless) | Each entry has a time limit (transit: 1 week, others: 1 month). Files are written atomically, a corrupt file counts as a miss, and the cache falls back to memory if the disk can't be written. Identical requests in flight share one fetch, and an expired answer is used when the API is down. | `lib/http.ts` |
| No limits or cancellation on `/api/plan` | Per-visitor and at-once limits (in-memory, one server process). Closing the page or clicking **stop planning** cancels the Claude run. | `lib/limits.ts`, `app/api/*/route.ts`, `app/page.tsx` |
| `schedule()` mutated the caller's shortlist | It works on copies | `lib/scheduler.ts` |
| Budget estimate counted the airport → hotel fare but not hotel → airport | Both are counted | `lib/scheduler.ts` |
| Earlier restaurant picks weren't rechecked after a reschedule; stale picks blocked valid ones | One shared rule, `mealMisfit()`, rechecks picks; only current slots count as "used" | `lib/scheduler.ts`, `lib/planner.ts` |
| Opening hours drifted an hour on the **server's** daylight-saving days | Minutes are read from date fields instead of timestamp differences | `lib/hours.ts` |
| Page text was black on dark in dark-mode browsers | Explicit colors and `color-scheme: light` | `app/globals.css` |

### 2. Scheduler: estimates first, then real transit (new `lib/verify.ts`)

The scheduler still plans with **estimated** travel times. Calling real transit for every candidate order would take minutes and cost nothing in tokens, but would be far too slow. What changed is how a mismatch with reality is handled:

1. **`start_kind` on draft stops.** `"fixed"` means a booked start the traveler must make. `"not_before"` means only "don't start before" (opening times, meals, waits). Only fixed starts can be "missed". Most of the old false errors came from holds being treated as appointments. If `start_kind` is missing, the stop counts as fixed, so the old agent flow and saved samples behave as before.
2. **`verify()` closes the loop.** It runs the real check, and if there are errors it reschedules **once** with the travel times just observed. It also scales the estimate for unseen legs by the median of real time ÷ estimate across observed transit legs, clamped to 0.6–1.8×. It keeps whichever plan scores better.
3. **Last resort:** on days that still fail for a reason a shorter day can fix (`missed_start`, `day_too_long`, `misses_flight`, `closed`), one "nice" stop is dropped. Which one is decided by `dropCandidate()`:
   - a closed stop first
   - for a missed start, a stop *before* the late one
   - otherwise, the stop whose removal frees the most time (visit length + the extra travel it adds)

   Must-sees and meals are never dropped.
4. Anything still broken is listed as `could not fix automatically: ...` rather than hidden.

This means at most 3 real checks each time `verify()` runs, the same as the old fix loop.

### 3. Claude API cost

- Effort defaults to `low` (it was `medium`). **Not measured yet.** Do one real run on the new defaults to get a baseline before tuning further.
- The tool list is built once and is identical across trips: fixed `web_search` limit of 6, no per-trip `user_location`. That way the cached prompt prefix can be reused.
- The prompt asks the agent to run independent searches in the same turn, which means fewer turns. Each turn re-sends the whole conversation.
- Notable sights near the destination (ones with Wikipedia/Wikidata links) are looked up before the agent starts and listed in the first message.
- Replans list only the plan's own places, not the whole registry (Boston had 103).
- `UsageTotals` logs tokens and approximate cost per run.

### 4. Map and itinerary

- Light base map by default (`light`/`streets`/`satellite` toggle) and colorblind-safe day colors (Okabe-Ito).
- Solid routes with white edges and direction arrows. In the all-days view, days are drawn slightly side by side so overlapping routes stay visible.
- Stops are clickable markers numbered in visiting order, matching badges in the itinerary. Meals are ring markers. Markers on the same spot fan out.
- **Interactions:**
  - hover a route or marker (all days) → that day comes forward, the others fade
  - click a stop or route on the map → highlights and scrolls to it in the itinerary
  - click a stop or move in the itinerary → the map zooms to that step
  - single-day view: a step-through bar (‹ › or arrow keys, Esc to clear) walks through the day one move at a time
- Legend under the map.
- The data shaping is in `lib/mapData.ts` (pure, tested); `components/TripMap.tsx` only renders.

## Internal API changes (if you have code on top of `main`)

| Before | After |
|---|---|
| `evaluatePlan(intake, draft, registry, log, keepApart)` | `evaluatePlan(intake, draft, registry, { log, keepApart, signal })` |
| `schedule(intake, list, registry, previous, fixedMeals)` | `schedule(intake, list, registry, { previous, fixedMeals, feedback })` |
| `verify()` in `lib/planner.ts` | `verify(intake, list, draft, registry, { log, meals, signal })` in `lib/verify.ts`, returns `unresolved` too |
| `runPlanner/runAgent(intake, emit, prior)` | `(intake, emit, prior, signal)`; the `Prior` type is in `lib/types.ts` |
| `haversineKm` defined in `lib/geo.ts` | Lives in `lib/distance.ts` (safe for client code); `geo.ts` re-exports it |
| Travel-time guesses spread across files | `estimate.*` in `lib/rules.ts`, shared by the scheduler and checker |
| `DAY_COLORS[i]` | `dayColor(i)` in `lib/colors.ts` (new palette) |

New files: `lib/verify.ts`, `lib/limits.ts`, `lib/mapData.ts`, `lib/distance.ts`, `vitest.config.ts`, `tests/*`.

## What was checked, and what wasn't

**Checked:**
- `npm test` (38 passing), `tsc`, `eslint`, `next build`
- In the browser with the Boston sample: map rendering, day focus, the stepper, the list ↔ map link, removing a lunch kept its museum, and **dev: reschedule** passed the first real check with 0 errors.

**Not checked:**
- A real `plan trip` run with Claude. There was no API key in the dev environment, so the new prompt, low effort, notable-sight preloading and cost logging haven't run end to end.
- The rate limiter is per server process. A multi-instance deployment needs a shared store (e.g. Redis).

## Still open

- **No auth** on `/api/plan`. The rate limit caps abuse but doesn't identify users. This is a product decision.
- **Measure cost:** compare Opus `low` vs `medium`, and try Sonnet 5.5, on a set of 20–30 saved trip requests. The checker's error count works as a free quality score.
- **Parked:** restaurant picking with a rating system. Intentionally not started; do it after the app is stable.
