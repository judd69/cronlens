# Contributing to CronLens

CronLens decodes standard 5-field cron expressions entirely in the browser:
plain English, next run times, and the gotchas that silently break schedules.
There is no server, no signup, and nothing leaves the page — keep it that way.

## Run it

```bash
npm install
npm run dev      # local dev server (Vite)
npm test         # Vitest suite — run before opening a PR
npm run build    # type-check (tsc) + production build into docs/
```

## Layout

- `src/cron.ts` — the cron parser, plain-English rendering, next-run
  calculation, and gotcha detection. Parser changes belong here.
- `src/main.ts` — UI wiring (builder, shareable `?q=` URLs, copy actions).
- `src/style.css`, `index.html` — presentation and entry page.
- `tests/` — Vitest suite for the parser and its edge cases.
- `docs/` — production build output published via GitHub Pages. Do not
  hand-edit files in `docs/`; regenerate them with `npm run build`.

## Project rules

- Standard crontab semantics only: five fields (minute, hour,
  day-of-month, month, day-of-week), lists, ranges, steps, and the
  `@yearly` / `@monthly` / `@weekly` / `@daily` shortcuts. Six-field
  seconds-first expressions (Quartz/Spring) are an error with a hint,
  not something to silently accept.
- Day-of-month and day-of-week are OR'd when both are set — never
  present them as AND. Any change touching that rule must update the
  plain-English text, the gotcha warning, and the tests together.
- No network calls, no dependencies beyond what is already in
  `package.json`, and no tracking. A PR that phones home will not merge.
- Keep the demo honest: example expressions in the README must produce
  exactly the output shown. If behaviour changes, update the examples.

## Opening a PR

- One focused change per PR, with a clear title.
- Parser or analyser changes need a test in `tests/` covering the new
  behaviour, including the edge case that motivated it.
- Docs-only PRs (like this guide) still need `npm test` to pass if they
  touch anything under `src/` or `tests/`; pure docs changes do not.
- Link the issue the PR fixes, if there is one.
