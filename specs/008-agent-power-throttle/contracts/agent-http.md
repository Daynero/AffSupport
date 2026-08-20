# Contract: Agent HTTP surface

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md)

Three additions to the local agent's HTTP API, registered in `apps/agent/src/server/app.ts` alongside the existing health routes. All follow the house conventions in Principle V: success returns the tool's state snapshot, errors return `reply.code(N).send({ error })` with a stable machine code.

**Base**: `http://127.0.0.1:43120`

**Auth**: all three sit behind the existing chain — origin allowlist, per-boot session token, and the entitlement gate. They are deliberately **not** in `ENTITLEMENT_EXEMPT_ROUTES` ([research R7](../research.md#r7--entitlement-gating-and-the-degraded-ui-state)).

---

## `GET /api/power`

Current snapshot. Cheap; safe to call on mount.

**Request**: no body. Session token per the existing scheme.

**Response `200`** — `PowerState` ([shared-types.md](./shared-types.md#state-types)):

```json
{
  "limitPercent": 40,
  "mode": "limited",
  "sample": {
    "availability": "ok",
    "systemSharePercent": 38.4,
    "activity": "active",
    "cpuCount": 10,
    "sampledAt": "2026-08-20T09:14:03.221Z"
  },
  "throttlingSupported": true,
  "activeChildren": 1,
  "updatedAt": "2026-08-20T09:12:55.100Z"
}
```

When nothing is running and no client has been watching, `sample.availability` is `"warming-up"` and carries no percentage:

```json
{
  "limitPercent": 100,
  "mode": "unrestricted",
  "sample": {
    "availability": "warming-up",
    "activity": "idle",
    "cpuCount": 10,
    "sampledAt": "2026-08-20T09:14:03.221Z"
  },
  "throttlingSupported": true,
  "activeChildren": 0,
  "updatedAt": "2026-08-20T09:00:00.000Z"
}
```

**Errors**: `401 { "error": "TOKEN_INVALID" }`, `403 { "error": "ORIGIN_NOT_ALLOWED" }` / `{ "error": "ENTITLEMENT_REQUIRED" }` — all from the existing shared guards, not re-implemented here.

---

## `POST /api/power/limit`

Set the ceiling. Applies to running work and to work started afterwards.

**Request**:

```json
{ "limitPercent": 40 }
```

Parsed by `parsePowerLimitRequest` — the body is typed `unknown` and narrowed, never read off a route generic. A finite out-of-range number is clamped, not rejected.

**Response `200`**: the updated `PowerState`, identical in shape to `GET`. The response is authoritative: the UI adopts the returned `limitPercent`, which is how a clamped request self-corrects the lever.

**Errors**:

| Status | `error` | When |
|---|---|---|
| `400` | `POWER_LIMIT_INVALID` | Body is not an object, `limitPercent` missing, not a number, `NaN`, or `Infinity` |
| `401` | `TOKEN_INVALID` | Missing/incorrect session token |
| `403` | `ORIGIN_NOT_ALLOWED` / `ENTITLEMENT_REQUIRED` | Existing guards |
| `500` | `POWER_PERSIST_FAILED` | The value could not be written to `power.json`. **The in-memory limit is left unchanged** — the lever must never display a limit that will not survive a restart (FR-006, [data-model invariant 5](../data-model.md#invariants)) |

**Side effects, in order**: persist atomically → recompute the CPU budget → retune the duty cycler → broadcast `PowerState` to every SSE subscriber → reply. The broadcast is what satisfies FR-023 (other windows agree) with no extra client machinery.

**Idempotent**: setting the same value again is a no-op that still returns `200` and still broadcasts.

---

## `GET /api/power/events`

SSE channel carrying live `PowerState` frames. Uses the existing `EventChannel` (`apps/agent/src/server/sse.js`) with its per-client write guard.

**Request**: `GET /api/power/events?token=<session token>` — the token travels in the query string because `EventSource` cannot set headers, matching every other SSE endpoint in the agent (`/api/events`, `/api/landing/events`, …).

**Response**: `text/event-stream`. The current snapshot is replayed immediately on connect, then a frame per sample tick.

```
data: {"limitPercent":40,"mode":"limited","sample":{...},"throttlingSupported":true,"activeChildren":1,"updatedAt":"..."}

data: {"limitPercent":40,"mode":"limited","sample":{...},"throttlingSupported":true,"activeChildren":1,"updatedAt":"..."}
```

**Cadence**: one frame per second while subscribed, satisfying FR-016's ≤ 2 s refresh with margin. A limit change broadcasts an extra frame immediately rather than waiting for the next tick.

**Sampling lifecycle** (FR-019): the 1 s tick starts when the subscriber count goes 0 → 1 and stops when it returns to 0. No client watching means no measurement cost at all. The tick timer is `.unref()`'d.

**Reconnect**: the web uses the existing `useAgentEventStream` hook, which reconnects on error after ~4 s and replays the snapshot on connect — so a dropped stream self-heals without special handling.

---

## Health payload

`GET /api/health` and `GET /health` gain nothing new of their own — the `toolContracts` map they already emit picks up `power: 1` automatically from `AGENT_TOOL_CONTRACTS`. That is the whole mechanism behind FR-022.

---

## Route-level test matrix

Covered by `tests/power-routes.test.ts`, assembled against a real Fastify instance the way `tests/agent-http.test.ts` does it:

| Case | Expected |
|---|---|
| `GET /api/power` fresh agent | `200`, `limitPercent: 100`, `mode: "unrestricted"` |
| `POST` `{ limitPercent: 40 }` | `200`, `limitPercent: 40`, `mode: "limited"` |
| `POST` `{ limitPercent: 150 }` | `200`, clamped to `100` |
| `POST` `{ limitPercent: 5 }` | `200`, clamped to `20` |
| `POST` `{}` / `{ limitPercent: "40" }` / `{ limitPercent: NaN }` | `400 POWER_LIMIT_INVALID` |
| `POST` with the store unwritable | `500 POWER_PERSIST_FAILED`, and a following `GET` still shows the **old** limit |
| `GET` without a token | `401 TOKEN_INVALID` |
| `GET` from a disallowed origin | `403 ORIGIN_NOT_ALLOWED` |
| `GET` without entitlement | `403 ENTITLEMENT_REQUIRED` |
| `POST` then a connected SSE client | Client receives a frame carrying the new limit |
| Last SSE client disconnects | Sampling tick stops (observed via the probe not being called again) |
| Health payload | `toolContracts.power === 1` |
