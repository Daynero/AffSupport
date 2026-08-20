# Contract: `@video-compressor/shared` additions

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md)

Everything the agent and the web app both need to agree on. Per Principle I these bounds are canonical — no module re-derives 20 or 100 inline.

---

## `packages/shared/src/types.ts`

### Bounds and defaults

```ts
/** Minimum share of the machine Soty may be limited to. Below this, work stalls. */
export const POWER_LIMIT_MIN = 20;
/** Maximum share — the unrestricted setting. */
export const POWER_LIMIT_MAX = 100;
/** What a user who has never touched the control gets. */
export const DEFAULT_POWER_LIMIT = POWER_LIMIT_MAX;
```

### Clamp helper

```ts
/**
 * The single authority for a valid limit: rounds to an integer and clamps into
 * [POWER_LIMIT_MIN, POWER_LIMIT_MAX]. Non-finite input yields the default.
 * Every entry point — HTTP body, persisted file, governor setter — goes through
 * this; no other place may compare against the bounds.
 */
export function clampPowerLimit(value: number): number;
```

Behaviour table (the test matrix):

| Input | Result |
|---|---|
| `55` | `55` |
| `55.4` / `55.6` | `55` / `56` |
| `0` / `-10` / `19` | `20` |
| `101` / `1000` | `100` |
| `NaN` / `Infinity` / `-Infinity` | `100` (default) |

### State types

```ts
export type PowerMode = 'unrestricted' | 'limited';
export type PowerActivity = 'idle' | 'active';

/**
 * Consumption reading. A discriminated union rather than a nullable number so a
 * caller cannot render "unavailable" as 0% — FR-018.
 */
export type PowerSample =
  | {
      availability: 'ok';
      /** Soty's share of total system capacity, 0–100, one decimal. */
      systemSharePercent: number;
      activity: PowerActivity;
      cpuCount: number;
      sampledAt: string;
    }
  | {
      /** Warming up (no delta yet), platform probe unsupported, or probe failed. */
      availability: 'warming-up' | 'unsupported' | 'error';
      activity: PowerActivity;
      cpuCount: number;
      sampledAt: string;
    };

/** The snapshot both routes return and every SSE frame carries. */
export interface PowerState {
  limitPercent: number;
  mode: PowerMode;
  sample: PowerSample;
  /** False when this host cannot throttle already-running work. */
  throttlingSupported: boolean;
  activeChildren: number;
  updatedAt: string;
}

/** SSE frame shape for /api/power/events — the state, unwrapped. */
export type PowerEvent = PowerState;
```

### Request guard

```ts
/**
 * Narrows an untrusted POST body. Returns the discriminated parse result the
 * codebase uses everywhere else — never throws, never casts.
 */
export function parsePowerLimitRequest(
  input: unknown
): { ok: true; value: { limitPercent: number } } | { ok: false; error: string };
```

Accepts only `{ limitPercent: <finite number> }`. Rejects (with `'POWER_LIMIT_INVALID'`) a non-object, a missing key, a non-number, `NaN`, or `Infinity`. A finite but out-of-range number is **accepted and clamped**, not rejected — a client sending `150` means "maximum", and failing that request would be pedantic.

### Persisted shape

```ts
/** On-disk shape of power.json. Read as `unknown` and parsed, never trusted. */
export interface PersistedPowerState {
  limitPercent: number;
  updatedAt: string;
}

export function parsePersistedPowerState(
  input: unknown
): { ok: true; value: PersistedPowerState } | { ok: false; error: string };
```

---

## `packages/shared/src/release.ts`

```ts
export const AGENT_TOOL_CONTRACTS = {
  compressor: 3,
  imageEmbedding: 2,
  landingOptimizer: 2,
  landingPreview: 2,
  transcription: 5,
  teamWorkspace: 2,
  power: 1            // NEW
} as const;

export const WEB_TOOL_REQUIREMENTS = {
  // …existing entries unchanged…
  power: { power: 1 } // NEW
} as const;
```

**`AGENT_API_VERSION` is not bumped** — it stays at `5`, with MIN and MAX both `5`. These routes are purely additive and change no existing request or response, which is exactly the case the contract map exists to cover ([research R9](../research.md#r9--contract-versioning-strategy)).

Consequence: the web gets FR-022 ("agent too old to honour the limit") for free from the existing `toolContractCompatible()` check against the health payload's `toolContracts` — an agent that predates this feature reports no `power` contract and the control renders unsupported.

---

## Compatibility notes

- **Additive only.** No existing type, constant, or contract value changes, so no existing caller can break.
- **`shared` must be rebuilt** before any gate that consumes the contract (`npm run build -w @video-compressor/shared`) — `packages/shared/dist` is committed, and Principle II requires validating against current constants rather than a stale `dist`.
- **`verify-release.mjs` needs no change**: it checks version agreement across `package.json` files, the manifest, and `production.env`; adding a tool-contract entry touches none of those.
