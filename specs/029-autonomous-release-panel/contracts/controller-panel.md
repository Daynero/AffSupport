# Contract: Local controller and panel

**Version**: 1 | **Status**: Proposed, not implemented

## Lifecycle CLI

Майбутні команди, які буде додано під час реалізації:

```text
npm run release:controller -- doctor --json
npm run release:controller -- accept --intent <absolute-path> --policy <absolute-path> --json
npm run release:controller -- status <task-id> --json
npm run release:controller -- panel <task-id>
npm run release:controller -- cancel <task-id> --json
npm run release:controller -- report <task-id> --json
```

`doctor/status/report` read-only і без моделі. `accept` лише explicit validated release intent; no implicit production target. Return task acceptance не дорівнює completed. `panel` відкриває capability bootstrap URL; no work/model activation. `cancel` scopes до власного task і fencing generation.

Controller control socket local, права 0600; CLI requests містять schemaVersion/requestId/operation/taskId. Executable registration immutable to intent/model. Production commands залишаються canonical runner; controller accept запускає цей lifecycle, не новий runbook.

## HTTP exposure

Bind `127.0.0.1:43150`, strict port ownership; зайнятий чужим процесом порт→PANEL_PORT_BUSY, чужий процес не завершується. Controller doctor повідомляє actual configured port. IPv6/LAN bind не додається.

| Method/path                                  | Result                                                                |
| -------------------------------------------- | --------------------------------------------------------------------- |
| POST /release-panel/api/session              | Single-use bootstrap token→session cookie; no-store                   |
| GET /release-panel/api/tasks                 | Bounded paginated history summaries                                   |
| GET /release-panel/api/tasks/:taskId         | Authoritative PanelSnapshot                                           |
| GET /release-panel/api/events                | One SSE stream per client, optional validated task filter             |
| GET /release-panel/api/logs/:opaqueRef       | Escaped redacted bounded tail, cursor/limit                           |
| POST /release-panel/api/tasks/:taskId/cancel | `{ expectedRevision, confirmation: "cancel-release" }`→202 cancelling |
| GET /release-panel/                          | Independent static UI                                                 |

No publish/deploy/repair shell endpoint. Owner blocker input у v1 через controller/initial agent; панель лише показує потрібну дію, не виконує arbitrary approval.

## Authentication and errors

Bootstrap capability генерується controller, TTL 60 с, single use, у URL fragment, не query. Browser очищає fragment і POST обмінює на random HttpOnly SameSite=Strict host-only session cookie. Loopback HTTP у v1: Secure cookie не припускається без TLS; session тільки для exact origin/port. Cookie TTL 8 год, per-boot server secret; refresh тільки через local capability launcher. Token/session ніде не логуються.

Host allowlist exact loopback host:configuredPort, Origin allowlist exact; Fetch-Metadata rejected for cross-site requests. Bootstrap POST може бути same-origin без session, решта API вимагає cookie. CSRF mutation перевіряє Origin + additional session-bound CSRF token. No CORS, frame-ancestors none, connect-src self, no remote scripts; Referrer-Policy no-referrer і Cache-Control no-store. Відсутній Origin у CLI не обходить session/control-socket authorization.

Errors `{ error: STABLE_CODE }`: 400 INVALID_REQUEST, 401 PANEL_SESSION_REQUIRED, 403 PANEL_ORIGIN_DENIED, 404 TASK_NOT_FOUND/LOG_REF_NOT_FOUND, 409 TASK_REVISION_CONFLICT, 413 REQUEST_TOO_LARGE, 503 CONTROLLER_UNAVAILABLE. Boot errors fail before writes. Logs max 100 lines/16 KiB per page; traversal/absolute file path parameters rejected.

## Snapshot and SSE

Snapshot shape відповідає [data-model](../data-model.md). Operational fields never contain keys, prompt content, arbitrary absolute paths або raw reasoning. Snapshot schemaVersion/revision/serverEpoch monotone per task epoch.

SSE event names:

- `snapshot`: authoritative safe projection; id `<serverEpoch>:<taskId>:<revision>`.
- `observation`: ephemeral executor/agent heartbeat with independent timestamps, does not mark work complete.
- `resync_required`: cursor unavailable or epoch changed; triggers one fresh snapshot.

Initial subscribe/reconnect/foreground reads snapshot, buffers overlapping events, then applies higher revisions. One provider/reconnect owner. SSE Last-Event-ID bounded/validated; limited replay buffer, no entire log dump. Out-of-order/duplicate revisions ignored. Unknown schema disconnects to visible unsupported state.

Heartbeat 10 с, stale after 30 с; client timer лише оновлює elapsed/stale display, не запитує сервер. Backpressure buffers bounded; slow client receives resync or disconnect, не зупиняє worker. Server and worker freshness розрізняються.

## UI contract

Header: version/target, overall estimated percent із tooltip «за підтвердженими етапами», status word/icon. Main: current step, active elapsed, waiting/repair reason, next automatic action. Ordered registry timeline показує included/excluded/completed/invalidated steps. Details: candidate ancestry, correlated Windows link, bounded logs, usage known/partial/unknown. Repair: waiting/accepted/running/validating, cause, attempt ordinal; no invented activity.

Existing Progress/Badge/Card/Alert/Timeline/Table/ConfirmDialog inventory і named tokens. Keyboard focus/reduced motion; status live-region announcements only transitions, not every heartbeat. Cancel quieter than Details; no mandatory Repair/Resume button. Closing window never changes task.
