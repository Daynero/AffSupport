# Data Model: зв'язок браузер ↔ Soty Agent

Усе — стан у пам'яті браузера й агента плюс події аналітики. Жодних нових таблиць; одна аддитивна міграція guard-а властивостей.

## Link State (веб, `AgentContext`)

```text
ConnectionState (без змін у назвах, щоб не ламати споживачів):
  checking | not_installed_or_not_running | pairing_required | connecting | connected
  | agent_update_required | web_update_required | connection_blocked | entitlement_blocked
  | disconnected

LinkReason (нове, пояснює не-connected стани; FR-012):
  not_running | not_installed | blocked_by_browser | pairing_rejected | agent_too_old
  | web_too_old | account_check_required | account_check_unavailable | update_in_progress
  | timeout | unknown

LinkStatus (нове поле контексту):
  connection: ConnectionState
  reason: LinkReason | null              // null лише при connected/checking/connecting
  attempt: { id, startedAt, trigger, stage } | null
  lastKnownAgent: { version, buildId, instanceId, channel, capabilities, toolContracts, seenAt } | null
  accountCheckPending: boolean           // R5
  lastLostAt: number | null
```

Похідні (зберігаються для сумісності): `agentVersion`, `capabilities`, `toolContracts`, `teamWorkspaceAvailable`, `toolAvailable(tool)`.

Нові предикати з причиною:

```text
Availability = 'ready' | 'disconnected' | 'too_old' | 'blocked' | 'account'
toolAvailability(tool): Availability
teamWorkspaceAvailability: Availability
```

Інваріанти:
- `too_old` лише при `connection === 'connected'`.
- `disconnected` ⇒ текст «Підключіть Soty» + дія «Перепідключити»; `too_old` ⇒ «Оновіть Soty» + посилання на оновлення.
- `lastKnownAgent` не стирається розривом; стирається лише зміною походження/виходом.

## Link Attempt

```text
trigger: boot | visibility | pageshow | online | manual | stream_lost | request_failed | token_changed | retry
stage:   probe | token | health | entitlement | snapshot | stream
outcome: connected | LinkReason
timeout: 8 000 мс на всю спробу (R4)
```

Одночасно не більше однієї; `manual` під час активної → приєднання (`joined: true`), після таймауту попередньої — нова.

## Stream Session (веб, `stream-client`)

```text
tokenGeneration: number     // інкремент при кожній зміні токена у сховищі
channels: string[]
lastByteAt: number
heartbeatMs: number         // з health, fallback 15 000
watchdogMs = 2*heartbeatMs + 5 000
endReason: closed | aborted | replaced | watchdog | unauthorized(401) | forbidden(403) | throttled(429) | network | parked
```

`watchConnection(listener)` тепер передає `{ open: boolean; reason?: endReason }`.

Backoff: `[500, 1000, 2000, 4000, 8000]` як є; для `replaced` — `[5000, 10000, 30000]`; для `unauthorized` — без повтору, передати власнику (він спарює й перезапускає); для `forbidden` — без повтору, власник оновлює entitlement.

## Agent-side

- `HealthResponse` (+ `heartbeatMs: number`, аддитивно).
- Auth-limiter key: `${ip}:${sha256(token).slice(0,8)}` для невдач; відсутній токен → `${ip}:none`.
- Shutdown: `hub.closeAll()` + `EventChannel.closeAll()` → `app.close()` з `forceCloseConnections: 'idle'` → жорсткий таймер 3 с.
- Handshake: `frameOrigin = allowed(request.origin ?? refererOrigin) ? that : pairOrigin`.
- Origin allowlist: + `http://localhost:<port>`.

## Analytics events (FR-025/026)

Усі з `flow_id` (uuid спроби/сесії потоку) і без секретів. Ключі, що потребують міграції guard-а, позначені ★.

| event | properties |
| --- | --- |
| `link_check_started` | `link_trigger`★ (enum вище), `link_origin`★ (`hosted`/`local_copy`), `browser_family`★ |
| `link_check_completed` | `outcome` (`success`/`failure`/`blocked`), `link_reason`★ (LinkReason), `duration_ms`★ (0..60000), `link_stage`★ |
| `link_lost` | `link_transport`★ (`stream`/`request`/`watchdog`), `link_reason`★ |
| `link_recovered` | `duration_ms`★ (0..86 400 000), `recovery_mode`★ (`auto`/`manual`/`local_copy`), `instance_changed`★ (bool), `token_changed`★ (bool) |
| `reconnect_clicked` | `surface`★ (enum поверхонь FR-010) |
| `pairing_started` / `pairing_completed` / `pairing_failed` | `pairing_method`★ (`fragment`/`handshake`/`navigation`), `link_reason`★ |
| `blocked_by_browser_detected` | `browser_family`★, `link_origin`★ |
| `link_inconsistency` | `link_transport`★ = `request`, `error_code` (HTTP-клас: `unauthorized`/`forbidden`/`connection_failed`), `link_stream_open`★ (bool) |

Кожна подія також несе наявні envelope-поля (web build, agent version/build, platform). `instanceId` не додається до envelope (не потрібен; `instance_changed` достатньо).

## CLI `connection` (data shape)

```json
{
  "ok": true, "command": "connection", "generated_at": "...", "period": {...},
  "data": {
    "users_with_loss": 0, "losses": 0, "recoveries": 0,
    "recovery_ms": { "p50": null, "p95": null, "samples": 0 },
    "recovery_mode": { "auto": 0, "manual": 0, "local_copy": 0 },
    "failed_checks_by_reason": [{ "reason": "...", "events": 0, "users": 0 }],
    "blocked_by_browser": [{ "browser_family": "...", "users": 0 }],
    "origins": [{ "link_origin": "...", "users": 0, "events": 0 }],
    "inconsistencies": { "events": 0, "users": 0 },
    "coverage": { "web_builds_with_link_events": 0, "web_builds_without": [ "..." ], "note": "builds without link events are uncovered, not healthy" }
  }
}
```
