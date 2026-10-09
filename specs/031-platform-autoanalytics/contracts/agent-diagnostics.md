# Contract: agent diagnostics log (031 FR-054)

## Log record

```ts
interface DiagnosticRecord {
  seq: number;              // monotonic per boot
  at: number;               // epoch ms
  category: 'boot'|'shutdown'|'stream'|'auth'|'entitlement'|'spawn'|'picker'|'drop'|'update'|'power'|'team';
  code: string;             // ^[a-z][a-z0-9_]{1,63}$ — stable machine code
  props?: Record<string, number | boolean | string>; // strings only from closed vocabularies; never paths/names/urls/tokens
}
```

Writers (via `diagnosticsLog.record(category, code, props)`): `index.ts` (boot, shutdown reason, exit code), `server/app.ts` (auth: token mismatch count bucket, limiter hit; handshake origin class), `server/sse.ts` (subscribe, evict, closeAll), `entitlement/entitlement.ts` (decision: active|grace|expired|invalid, clock skew bucket), `power/spawn.ts` (spawn started/exit category, signal, duration bucket; tool id), `files/picker.ts` (picker launch/visible-unknown/cancel/exit category), drop resolver (location class, outcome), queue update drain.

Bounds: 2 000 records or 1 MiB in memory; `diagnostics.jsonl` under App Support, written atomically at most every 5 s, rotated at 1 MiB (keep one previous file).

## `GET /api/diagnostics?since=<seq>&limit=<n>`

Existing response plus `log: DiagnosticRecord[]` (oldest first, `seq > since`, `limit ≤ 500`, default 200) and `nextSeq`. Session token required; entitlement-exempt (as today). No new CORS surface.

## Support bundle (web)

Built locally from `/api/diagnostics` (last 200 records), `lastKnownAgent`, web build, browser family, link reason, the last 20 `link_*` events the page emitted; rendered on screen in full; copied only on explicit click; `diagnostics_copied` event emitted (already declared). The bundle must pass the same client sanitizer as events (no paths, names, tokens).
