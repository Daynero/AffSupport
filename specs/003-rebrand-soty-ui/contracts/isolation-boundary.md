# Contract: Isolation Boundary

## Build boundary

`apps/soty-review` has its own package, Vite config, entrypoint and `dist`. Root convenience
scripts may start/build/preview it, but existing `build`, `build:web`, `deploy:web`, package,
release and manifest scripts MUST NOT include it. `apps/web/dist` must contain no Soty
review marker.

## Dependency boundary

Review source MUST NOT import:

- `apps/web/src/**` or any production component/provider;
- `@video-compressor/shared`;
- Supabase, API clients, analytics, Agent or Team runtime code;
- production env/config modules.

Only React, review-local source, synthetic assets and directly declared review dev tooling
are allowed. ESLint/static tests enforce the boundary.

## Runtime boundary

- Vite `envDir: false`, narrow review-only env prefix, no proxy.
- Dev/preview listen only on `127.0.0.1` with strict ports.
- CSP denies external forms, objects, frames and connections; self static content and
  loopback Vite HMR are the only connection exceptions.
- Application code MUST NOT use `fetch`, XHR, `sendBeacon`, WebSocket/EventSource, cookies,
  IndexedDB, local/session storage, service workers or native file APIs.
- All data is immutable synthetic fixture data and all behavior is reducer-local.

## Verification

The browser harness blocks and reports any non-review URL, enumerates at least 50
`data-demo-action` controls, invokes them and observes zero account/API/analytics/agent or
external requests. Static checks reject forbidden imports/globals. A production web build
is scanned for review iteration/brand markers.

Violation of any clause blocks visual review; it cannot be waived by calling a live action
“demo”.

