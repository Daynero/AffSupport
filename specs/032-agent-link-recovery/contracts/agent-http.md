# Contract: Agent HTTP additions (032)

All additive; `AGENT_API_VERSION` unchanged (5).

## `GET /health`, `GET /api/health`

+ `heartbeatMs: number` — the hub's heartbeat period (15000). Clients derive the read watchdog from it.

## `GET /api/stream`

- Unchanged auth (header or `?token=`), channels, snapshot-on-subscribe, `: heartbeat` every `heartbeatMs`.
- Eviction frame stays `event: replaced\ndata: {}` and is documented as a client-visible signal: the client MUST back off (5–30 s) before reconnecting.
- On agent shutdown every subscriber receives `event: shutdown\ndata: {"reason":"<update|restart|signal|launcher|error>"}` and the socket is ended before the server closes.

## `GET /pair/handshake?nonce=`

- `frame-ancestors` and `postMessage` target = the request's `Origin` (or `Referer` origin) when it is in the agent's origin allowlist; otherwise the configured `pairOrigin`. The local copy (`http://127.0.0.1:<port>`) and `http://localhost:<port>` are therefore served the handshake for themselves.

## Origin allowlist

+ `http://localhost:<port>`.

## Auth-failure limiter

- Key for failures: `${ip}:${sha256(presentedToken).slice(0, 8)}` (`${ip}:none` when absent).
- Requests whose token matches are never counted and never refused by this limiter.
- Code unchanged: 429 `TOO_MANY_ATTEMPTS`.

## Shutdown ordering

1. `hub.closeAll('shutdown', reason)` and every per-tool `EventChannel.closeAll()`.
2. `app.close()` with `forceCloseConnections: 'idle'`.
3. Hard timer 3 s → `process.exit(code)` regardless.

Exit codes unchanged (75 restart, 76 update).
