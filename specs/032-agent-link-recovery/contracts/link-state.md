# Contract: Link State and Reconnect Surfaces

## 1. Owner

`AgentProvider` is the only writer of `connection`, `reason`, `attempt`, `lastKnownAgent`. Inputs:

| Input | Source | Effect |
| --- | --- | --- |
| `establish(trigger)` result | HTTP probe/health/queue | `connected` or `reason` |
| `streamClient.watchConnection` | multiplexed stream | `open:false` + reason → schedule `establish('stream_lost')` after grace 3 s; `unauthorized` → immediate pairing path; `forbidden` → entitlement path; `replaced` → wait |
| `useAgentEventStream` fallback `onDisconnect/onReconnect` | per-tool EventSource | unchanged |
| `onPairingToken` | storage broadcast | `establish('token_changed')` + `streamClient.restart()` |
| `visibilitychange→visible`, `pageshow`, `online` | document/window | debounce 500 ms → `establish('visibility' / 'pageshow' / 'online')` only if not `connected` or `lastByteAt` older than watchdog |
| any `request()` failure with 401/403/CONNECTION_FAILED while `connection==='connected'` | `api/client` reports via `reportRequestFailure(kind)` | `link_inconsistency` + `establish('request_failed')` |

## 2. Timing

| Constant | Value | Why |
| --- | --- | --- |
| grace before reporting loss | 3 000 ms | FR-002 lower bound |
| max time to report loss | 10 000 ms | FR-002 upper bound (watchdog + grace) |
| attempt timeout | 8 000 ms | FR-009 |
| retry while not connected | 4 s ×2, then 15 s | FR-008 |
| stream watchdog | `2 × heartbeatMs + 5 000` | FR-003 |
| visibility debounce | 500 ms | FR-004 |
| fragment token re-verify | 3 tries over 30 s | FR-019 |
| account check retry | 30 s → 5 min (×2) | FR-015 |

## 3. Availability predicates

```ts
type Availability = 'ready' | 'disconnected' | 'too_old' | 'blocked' | 'account';
toolAvailability(tool: SotyToolId): Availability;
teamWorkspaceAvailability: Availability;
```

Mapping to copy (i18n keys):

| Availability | Headline | Action |
| --- | --- | --- |
| `disconnected` | `linkConnectSoty` «Підключіть Soty» | `linkReconnect` «Перепідключити» |
| `too_old` | `localAppUpdateTitle` «Оновіть Soty…» | update link |
| `blocked` | `linkBrowserBlocked` | `openSoty` (local copy, same path) |
| `account` | `entitlementTitle` | `reconnectThroughSoty` / `tryAgain` |

A surface MUST NOT choose copy from a boolean. `teamWorkspaceAvailable` and `toolAvailable()` remain as derived booleans for callers that only gate actions.

## 4. Reconnect surface

`<ReconnectAction surface="…" />` from the inventory (`Button` variant secondary, size sm). Props: `surface` (analytics enum), optional `compact`. Behaviour: calls `reconnect(surface)`; shows pending while `attempt` active; after completion shows a transient result (`connected` chip or reason text) for 4 s. Never disabled; a second press during an attempt marks `joined`.

Surfaces (enum for `surface`): `header_badge`, `home`, `account`, `compressor`, `transcription`, `stitcher`, `landing_optimizer`, `landing_preview`, `power`, `team_shell`, `team_actions`, `team_process_dialog`, `team_library_dialog`, `team_preview`, `team_landings`.

## 5. Stream client

```ts
configure(config: { agentUrl: string; token: () => string; heartbeatMs?: number } | null)
watchConnection(listener: (status: { open: boolean; reason?: StreamEndReason }) => void)
restart(): void   // public: token changed
```

`StreamEndReason = 'closed' | 'aborted' | 'replaced' | 'watchdog' | 'unauthorized' | 'forbidden' | 'throttled' | 'network' | 'parked'`.

`readEventStream` additions: `onActivity()` per chunk; `onNamedEvent(name)` for `event:` lines; throws `StreamRefusedError(status)`.
