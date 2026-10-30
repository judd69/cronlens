# CronLens — cron expressions, decoded before you deploy

Cron expressions are five cryptic fields, and there is no feedback until your
job fires at the wrong time. You copy `0 0 1 * 1` from Stack Overflow, deploy
it, and only later learn it does **not** mean "midnight on the 1st, if it is a
Monday" — day-of-month and day-of-week are **OR'd**, so it fires on the 1st of
every month *and* on every Monday. The same class of silent mistake covers
`*/15` (anchored to :00, not to when you deploy), six-field seconds-first
expressions pasted from Quartz/Spring into crontab, impossible dates like
30 February, and expressions that carry no timezone at all.

CronLens decodes any standard 5-field cron expression in your browser, before
you deploy it:

- **Plain English** — what the schedule actually does, field by field, with
  each field's matched values spelled out.
- **Next 10 run times** — in your browser's local timezone, with "in 3h 12m"
  countdowns, plus a 7-day at-a-glance grid.
- **Gotcha detector** — flags the traps that pass code review: the
  day-of-month OR day-of-week trap, anchored `*/n` steps, Sunday-as-7,
  schedules that never run (e.g. 30 February), and the missing timezone.
- **Visual builder** — pick a pattern (every N minutes, hourly, daily,
  weekdays, weekly, monthly, yearly) and CronLens writes the expression.
- **Shareable** — every expression gets a `?q=` URL; copy the expression, a
  crontab line, or a one-line summary.

Runs entirely in the browser. No server, no signup, nothing leaves the page.

## Live demo

https://judd69.github.io/cronlens/ (flip Pages: Settings → Pages → branch main, folder /docs)

## Run it

```bash
npm install
npm run dev      # local dev server
npm test         # Vitest suite
npm run build    # type-check + production build into docs/
```

## Example output

```
$ expression: 0 9 * * 1-5
In plain English: At 09:00, on Mon, Tue, Wed, Thu, Fri.
Next run: Thu, 29 Oct 2026 at 09:00 (in 2h, from 07:00 the same day)
Then: Fri 30 Oct 09:00, Mon 02 Nov 09:00 — weekends skipped.
≈ 22 runs in the next 30 days.

$ expression: 0 0 1 * 1
In plain English: At 00:00, on day 1 of the month OR on Mon — either one matches.
⚠ WARN: Day-of-month OR day-of-week — not AND
  Both day fields are set, so this runs when EITHER matches. It does NOT
  mean "only when both fall on the same day".

$ expression: 30 2 30 2 *
⛔ ERROR: This schedule never runs
  No matching minute exists in the next four years — 30 February does not exist.

$ expression: 0 0 9 * * *
ERROR: Six fields found — standard cron has five.
Hint: This looks like a seconds-first expression (Quartz/Spring).
Dropping the first field gives "0 9 * * *".
```

## Semantics (standard crontab, as implemented)

- Fields: minute (0–59), hour (0–23), day-of-month (1–31), month (1–12,
  JAN–DEC), day-of-week (0–7, SUN–SAT; 7 is Sunday, normalised to 0).
- Lists (`1,15`), ranges (`1-5`), steps (`*/15`, `2/15`, `1-10/3`).
- Shortcuts: `@yearly`, `@monthly`, `@weekly`, `@daily`, `@hourly`,
  `@reboot` (no recurring schedule).
- If both day fields are restricted, a minute matches when **either** matches.
  If only one is restricted, only it decides.
- Steps are anchored to the field origin (e.g. `*/15` fires at :00, :15, :30,
  :45), never relative to deploy time.
- Next-run search steps minute by minute (the honest way — it cannot miss an
  edge case clever arithmetic might) with a four-year cap, so impossible
  schedules are reported as never running instead of looping forever.

## Stack

TypeScript + Vite (vanilla DOM, zero runtime dependencies), Vitest for tests.
Production build ships in `docs/` with relative asset paths (`base: './'`) for
GitHub Pages.

## Tests

20 Vitest tests, all green: field parsing (names, lists, ranges, steps,
Sunday-7 normalisation, rejection of bad ranges/steps/`?`), shortcut
expansion, six-field detection with the seconds-first hint, the DOM/DOW OR
semantics, next-run computation (weekday skipping, anchored steps, leap day,
Feb 30 never running), plain-English descriptions, and every gotcha class.
