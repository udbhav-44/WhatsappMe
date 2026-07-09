# Interval Messages Within a Daytime Window — Design

Date: 2026-07-09
Status: Approved

## Problem

Interval schedules today fire around the clock. Cron `0 */2 * * *` sends every
2 hours including at night. Dad wants regular-interval messages restricted to a
daytime window (e.g. every 30 min between 9am and 6pm), optionally only on
certain days of the week (e.g. weekdays).

## Goals

- Interval schedules can be limited to a daytime window (whole-hour bounds).
- Interval granularity down to sub-hour: minutes (5/10/15/20/30), hours, days.
- Interval schedules can optionally restrict to days of the week.
- No database migration. No change to how the scheduler fires jobs.
- Existing schedules keep working unchanged.

## Non-goals

- Minute-precision window bounds (e.g. 9:30). Whole hours only.
- Window/day-of-week for the `days` interval unit (meaningless across days).
- Arbitrary minute intervals that don't divide 60 (would space unevenly).

## Approach

Cron remains the single source of truth (`schedules.cron_expr`). The window,
minute-step, and day-of-week all encode into the existing cron string. The pure
encode/decode helpers in `src/api/schedules.js` are extended; the scheduler
consumes the richer expression directly. This matches the current
"cron is truth, decode for UI" pattern and needs no migration.

## Cron encoding

Window = whole hours, end-inclusive. Empty days = every day (`*`).
Full-day window (start 0, end 23) encodes the hour field as `*` to preserve
existing behavior and keep the expression clean.

| Case | Cron |
|---|---|
| Every 30 min, 9–18, daily | `*/30 9-18 * * *` |
| Every 15 min, 8–20, weekdays | `*/15 8-20 * * 1-5` |
| Every 2h, 9–18, weekdays | `0 9-18/2 * * 1-5` |
| Every 2h, all day (existing) | `0 */2 * * *` |
| Every 3 days (existing) | `0 0 */3 * *` |
| Daily 8:30 (existing) | `30 8 * * *` |
| Weekly Mon/Wed 9:00 (existing) | `0 9 * * 1,3` |

### toCron (interval branch)

Form fields: `intervalUnit` ∈ {minutes, hours, days}, `intervalValue`,
`windowStart` (0–23), `windowEnd` (0–23), `days` (array of 0–6, may be empty).

- `minutes`: `*/{value} {hourField} * * {dowField}`
- `hours`: `0 {hourStepField} * * {dowField}`
- `days`: `0 0 */{value} * *` (window and days ignored — unchanged)

Where:
- `hourField` = `*` if window is 0–23, else `{start}-{end}` (or `{start}` if start==end).
- `hourStepField` (hours unit) = `*/{value}` if window is 0–23, else `{start}-{end}/{value}` (or `{start}/{value}` if start==end).
- `dowField` = `*` if days empty, else sorted comma list e.g. `1,3,5` (or a range is acceptable but list is simplest to generate).

### fromCron (interval branch)

Decode by inspecting fields:
- Minute field starts `*/` → unit `minutes`; `intervalValue` = number after `*/`;
  parse window from hour field; parse days from day-of-week field.
- Hour field contains `/` → unit `hours`; split `range/step`:
  `intervalValue` = step; parse window from the range part (`*` → 0–23);
  parse days from day-of-week field.
- Day-of-month field starts `*/` → unit `days`; `intervalValue` = number;
  window defaults full day, days empty (not applicable).

Window parse helper: `*` → {0, 23}; `s-e` → {s, e}; single `s` → {s, s}.
Day-of-week parse: `*` → []; `1,3,5` → [1,3,5]; ranges like `1-5` → expand to [1,2,3,4,5].

### detectScheduleType

Interval detection must run BEFORE weekly, because a minute/hour interval can
carry a day-of-week list that would otherwise look weekly.

Classify as `interval` if ANY of:
- minute field starts with `*/`, OR
- hour field contains `/`, OR
- day-of-month field starts with `*/`.

Else `weekly` if day-of-week field != `*`.
Else `daily` if hour field != `*`.
Else fall back to `interval`.

Verification against existing crons:
- `0 */2 * * *` → hour has `/` → interval ✓
- `0 0 */3 * *` → dom starts `*/` → interval ✓
- `30 8 * * *` → no `/`, dow `*`, hour set → daily ✓
- `0 9 * * 1,3` → no `/`, dow set → weekly ✓

## API validation (`validateScheduleBody`)

For `scheduleType === 'interval'`:
- `intervalUnit` ∈ {minutes, hours, days} (was hours/days).
- `minutes`: `intervalValue` must be an integer in {5,10,15,20,30} (divides 60 → even spacing).
- `hours`: `intervalValue` integer 1–23.
- `days`: `intervalValue` positive integer (unchanged).
- For minutes/hours: `windowStart`, `windowEnd` integers 0–23 with `windowEnd >= windowStart`.
  Defaults if omitted: full day (0, 23).
- `days` (day-of-week array) optional; if present, integers 0–6, no dupes required but tolerated.

## Scheduler (`src/scheduler/manager.js`)

- `startJob` / `fireSchedule`: unchanged. node-cron@4 consumes
  `*/30 9-18 * * 1-5` and `0 9-18/2 * * *` directly. The implementation plan
  includes a quick runtime check that node-cron accepts these expressions.
- `estimateNextRun`: MUST be updated. It currently only recognizes `*/H` in the
  hour field and `*/D` in the day-of-month field, and would mis-estimate the new
  windowed/stepped forms. Its result feeds missed-message recovery on restart
  (`next_run`). New behavior: compute the next fire time from the parsed cron
  (minute step, hour window/step, day-of-week). A correct lightweight walk:
  find the next timestamp >= now (IST) whose minute/hour/day-of-week satisfy the
  expression. Reuse a small matcher rather than hand-casing each shape.

## Frontend (`src/web/app.html`)

In the interval ("Repeat") block:
- Unit select gains **minutes**. For the minutes unit, `intervalValue` is chosen
  from {5,10,15,20,30} (dropdown) to guarantee even spacing.
- **Window row** ("between [from] and [to]", whole-hour number inputs 0–23),
  shown only for minutes/hours units.
- **Day chips** reused from the weekly UI, optional; none selected = every day.
- `describeSchedule` (schedule summary text) updates for interval, e.g.
  "every 30 min, 9:00–18:00, Mon–Fri" / "every 2 hours, all day".
- Form state (`emptyForm`, edit-load, save payload) gains `windowStart`,
  `windowEnd`, and reuses `days` for interval. Client-side `validateForm`
  mirrors the server rules (end >= start, minutes in allowed set).

## Edge cases

- Full-day window (0–23) → hour field `*` → identical to today's 24/7 interval.
- End-inclusive: window 9–18 hourly fires at 9,10,…,18.
- `days` interval unit ignores window and day-of-week (kept as `0 0 */D * *`).
- Editing an existing 24/7 interval shows full-day window + no days; saving it
  unchanged reproduces the original cron.

## Testing

- Unit round-trip: for each case in the encoding table, `toCron(fromCron(...))`
  is stable and `detectScheduleType` classifies correctly.
- Validation: reject minutes not in {5,10,15,20,30}, hours outside 1–23,
  `windowEnd < windowStart`, day-of-week outside 0–6.
- `estimateNextRun`: next fire for `*/30 9-18 * * 1-5` from a Sat night lands on
  the following weekday 09:00; from mid-window lands on the next slot.
- node-cron accepts the generated expressions (runtime smoke check).
- Manual: create a "every 30 min, 9–18, weekdays" schedule; confirm summary text
  and that it does not fire at night.
