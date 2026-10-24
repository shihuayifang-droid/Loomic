# Web composer E2E (Playwright)

- Run: build first (`NEXT_PUBLIC_HAHART_AUTH_PROVIDER=self`, `NEXT_PUBLIC_SERVER_BASE_URL=same-origin`
  `pnpm --filter @loomic/web build`), then `pnpm --filter @loomic/web e2e`.
- Uses the machine's installed Microsoft Edge (`channel: "msedge"`); no browser is downloaded.
- `static-server.mjs` serves `apps/web/out` on port 4317; `/api/*` is 404 there.
- Every API call is mocked with `page.route` in `fixtures.ts`; no real backend, account or key.
- The session in localStorage is a placeholder (`e2e@example.invalid`).
- WebSocket is not connected; the page works in the disconnected state.
