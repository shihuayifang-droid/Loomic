# Web E2E (Playwright) — conventions

This directory holds the end-to-end tests for `apps/web` and **the conventions every E2E test must
follow**. Read this page before writing a new spec; a spec that breaks a rule below is rejected even
if it is green.

## 1. Why the `msedge` channel

`playwright.config.ts` sets `channel: "msedge"`, so Playwright drives the Microsoft Edge that is
already installed on the machine. Nothing is downloaded at install / run time, which is what lets the
suite run offline and in CI images that have no Playwright browser cache.

Consequence: **if the machine has no Edge, the suite cannot start.** Install a browser explicitly in
that case (any chromium build works, then drop `channel` in a local, uncommitted config — do not edit
the committed `playwright.config.ts` just to make one machine pass):

```
pnpm exec playwright install chromium
```

The rest of the committed config is fixed for this ticket: `workers: 1` (one browser at a time, the
mock API log in `composer.spec.ts` is per-page state), `retries: 0`, and a `webServer` block that
starts `static-server.mjs` on `127.0.0.1:4317` with `baseURL` pointing at it.

## 2. The three hard rules (from the QA-02 requirement)

1. **Exact testid matching.** Query elements with `page.getByTestId(...)` (i.e. `data-testid`).
   **CSS structural selectors are forbidden** — no `.div > div:nth-child(2)`, no class-name chains,
   no `nth-child` to "find the third row". If a node has no testid yet, add one to the component
   (see §6) instead of reaching for structure. Scoping a testid lookup by testid or by role is fine:
   `page.getByTestId("agent-mention-group").filter({ hasText: name })`.
2. **No coordinate clicks.** Never `page.mouse.click(x, y)`, `mouse.move(x, y)` before a click, or
   any other pixel-targeting action. Coordinates break on every layout change and on HiDPI /
   headless-vs-headed differences. Click the element (`getByTestId(...).click()`) or use the keyboard
   (`page.keyboard.press`, `page.keyboard.type`).
3. **Real input.** Drive text entry through the real event path — `page.keyboard.type()`,
   `page.keyboard.press()`, or `@testing-library/user-event` in unit tests. Setting
   `element.value = "..."`, `page.evaluate` on an input's `.value`, or dispatching a synthetic
   `input` event **bypasses React state** and produces tests that pass while the app is broken. The
   composer is controlled, so its state must come from real keystrokes.

## 3. Mock data only — never a real backend

- Every request is intercepted: `mockApi(page)` in `fixtures.ts` registers `page.route("/api/**")`
  handlers, and `static-server.mjs` returns 404 for `/api/*`, so an un-mocked call fails loudly
  instead of silently hitting a server.
- **Never point an E2E test at a real backend, real Supabase project, real account or real API key.**
- The ids in `fixtures.ts` (`IDS`) are placeholders of the `00000000-...` family, and the seeded
  session uses `e2e@example.invalid`. **Do not write a real account, tenant id or key into a
  fixture.** Add a new placeholder id instead.
- Binary assets are inline constants (`PNG_1X1_BASE64`) so no file on disk or network resource is
  needed.
- The session in `localStorage` is a placeholder, and the WebSocket is not connected: tests must run
  and pass in the disconnected state.

## 4. Static export is a prerequisite

`static-server.mjs` only serves the pre-built static export in `apps/web/out` — it does not compile
anything. So **build first**:

```
pnpm --filter @loomic/web build
```

The build must run with the two public env vars set (they are inlined at build time, so setting them
after the build has no effect):

- PowerShell: `$env:NEXT_PUBLIC_HAHART_AUTH_PROVIDER="self"; $env:NEXT_PUBLIC_SERVER_BASE_URL="same-origin"; pnpm --filter @loomic/web build`
- bash: `NEXT_PUBLIC_HAHART_AUTH_PROVIDER=self NEXT_PUBLIC_SERVER_BASE_URL=same-origin pnpm --filter @loomic/web build`
- Warning: do not use cmd `set X=v&& ...` (the space before `&&` becomes part of the value, so the
  build does not use the self auth provider).

The `e2e` script checks for `out/index.html` and exits non-zero with a `node:fs` `ENOENT` error when
the export is missing, so a forgotten build fails immediately instead of testing a stale bundle.
Rebuild after any `apps/web` source change; the server never rebuilds.

## 5. How to run

```
# whole suite (from anywhere in the repo)
pnpm --filter @loomic/web e2e

# one spec only
pnpm --filter @loomic/web e2e composer.spec.ts

# watch it happen (debugging)
pnpm --filter @loomic/web e2e --headed
```

The exit code is the source of truth. On failure Playwright prints the failing test name and the
first error; use `--headed` (or `--debug` for the inspector) to watch the run. Traces/screenshots
from the configured reporters land in the default `test-results/` directory.

## 6. Requirements for a new test case

- Use **only** testids (`getByTestId`) plus real keyboard input. No CSS structure, no coordinates,
  no direct `value` assignment.
- When a UI element needs to be targeted and has no testid, **add `data-testid` to the component
  first**, then use it. Naming is `area-element` in kebab-case, e.g. `composer-send`,
  `composer-input`, `agent-drop-overlay`. Prefer a name that describes the role, not the styling.
- Mock every API call the flow needs via `fixtures.ts`; return placeholders only.
- Assert on user-visible state (visible text, testid counts, the recorded `ApiLog`), not on internal
  implementation details.
- Keep the spec in `apps/web/e2e/*.spec.ts` (config `testMatch` is `.*\.spec\.ts`).

## 7. Known deviation in the current suite

`composer.spec.ts` still locates the drop zone with a class-based selector
(`div.flex.h-full.shrink-0`) because that panel has no testid yet. That is exactly the case the
conventions forbid: the follow-up case ticket must add a testid (e.g. `agent-drop-zone`) to the panel
and replace the selector. Do not copy the pattern into new specs.
