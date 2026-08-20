# Contract: Web UI surface

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md)

The header control, the thrust lever, and the live readout. Behaviour and accessibility are contract; visual styling is not specified beyond what the user asked for.

---

## Placement

`<PowerThrottle />` mounts in the `topbar-actions` cluster in `apps/web/src/App.tsx:609`, immediately before `<ThemeToggle />` — the "поруч зі зміною теми" the request named. It renders wherever the app header renders.

```tsx
<div className="topbar-actions">
  <PowerThrottle />
  <ThemeToggle />
  <div className="language-switch">…</div>
  <ConnectionBadge … />
  <UserMenu />
</div>
```

---

## Header button

| Property | Contract |
|---|---|
| Element | `<button type="button" class="power-toggle">` |
| Icon | A power glyph, inline SVG, `currentColor`, 20×20 — matching `ThemeToggle`'s sizing so the cluster stays even |
| Reduced-limit indication | When `mode === 'limited'`, the button carries a visible state (`data-limited="true"`) — FR-005 requires the limit be legible without opening the panel |
| `aria-label` | `t('powerControl')`, e.g. "Soty power limit" |
| `aria-expanded` | Tracks panel open state |
| `aria-haspopup` | `"dialog"` |
| `title` | Current limit, e.g. `t('powerLimitAt', { percent: 40 })` |

---

## Panel

Opens on click, closes on a second click, on `Escape`, and on pointer-down outside. Focus moves into the panel on open and returns to the button on close.

| Property | Contract |
|---|---|
| Element | `<div class="power-panel" role="dialog" aria-label={t('powerControl')}>` |
| Contents, top to bottom | Title → `<PowerLever />` → `<PowerReadout />` |
| Dismissal | Second click, `Escape`, outside pointer-down |
| Focus | Trapped while open; restored to the trigger on close |

---

## `<PowerLever />` — the thrust lever

A vertical throttle drawn as an aircraft thrust lever with a marked power scale, per the request ("вертикальний ползунок зроблений як ричаг літака зі шкалою потужності"). Full travel at the top is 100%.

**Accessibility** — this is a slider, and must be one to assistive technology (FR-004):

```html
<div role="slider"
     aria-orientation="vertical"
     aria-valuemin="20"
     aria-valuemax="100"
     aria-valuenow="40"
     aria-valuetext="40%"
     aria-label="Power limit"
     tabindex="0">
```

**Keyboard**:

| Key | Effect |
|---|---|
| `↑` / `→` | +1% |
| `↓` / `←` | −1% |
| `Page Up` / `Page Down` | ±10% |
| `Home` | `POWER_LIMIT_MIN` (20) |
| `End` | `POWER_LIMIT_MAX` (100) |

**Pointer**: drag the handle, or click anywhere on the track to jump there. Dragging captures the pointer so movement outside the track still tracks.

**Scale**: labelled gradations at 20 / 40 / 60 / 80 / 100. Values are integers throughout — no fractional limit is representable.

**Inline style**: exactly one computed value, the handle's travel offset (`--power-travel`). Everything else is `className` against `styles.css`, per Principle VI.

**Optimistic update + debounce**:

1. Pointer/key input updates local state immediately — the lever must feel physical, not networked.
2. The `POST` is debounced ~200 ms, so a drag sends one request, not fifty.
3. The response is authoritative: the lever adopts the returned `limitPercent`, which is how a clamped value self-corrects.
4. On failure the lever **returns to the last effective value** and an error is surfaced (FR-006). It never sits at a position that is not in force.

Rapid dragging must leave the lever and the applied limit in agreement — last position wins, no interleaving. This is a named test.

---

## `<PowerReadout />` — the live figure

The text beneath the lever, satisfying FR-015 through FR-018. What it shows is driven entirely by `sample.availability` and `sample.activity`:

| Condition | Rendered |
|---|---|
| `availability: 'ok'`, `activity: 'active'` | `t('powerUsageActive', { percent: 38.4 })` — e.g. "Soty is using 38.4% of your computer" |
| `availability: 'ok'`, `activity: 'idle'` | `t('powerUsageIdle', { percent: 0.2 })` — e.g. "Soty is idle — 0.2%" |
| `availability: 'warming-up'` | `t('powerUsageMeasuring')` — "Measuring…" |
| `availability: 'unsupported'` | `t('powerUsageUnsupported')` — no figure |
| `availability: 'error'` | `t('powerUsageUnavailable')` — no figure |
| Agent not connected | `t('powerAgentOffline')`, lever **still movable** at its stored position; the chosen value is held and posted on reconnect rather than discarded (FR-021) |
| Agent contract too old | `t('powerAgentOutdated')` + update prompt, lever disabled (FR-022) |
| `throttlingSupported === false` | `t('powerThrottleUnsupported')` — the limit applies to newly started work only |

The rule that matters: **no percentage is ever rendered from a non-`ok` sample.** The discriminated union makes that a type error rather than a discipline problem.

`aria-live="polite"` on the readout so a screen reader hears changes without the value being announced on every tick.

---

## State store — `apps/web/src/lib/power.tsx`

The house context idiom (Principle VI), same shape as the existing theme and i18n stores:

```tsx
const PowerContext = createContext<PowerContextValue | null>(null);

export function PowerProvider({ children }: { children: ReactNode }): JSX.Element;

/** Throws when used outside its provider. */
export function usePower(): PowerContextValue;

/** Test seam, mirroring the other *ContextOverride helpers. */
export function PowerContextOverride(props: {
  value: PowerContextValue;
  children: ReactNode;
}): JSX.Element;

interface PowerContextValue {
  state: PowerState | null;
  status: 'loading' | 'ready' | 'offline' | 'unsupported' | 'error';
  setLimit(percent: number): Promise<void>;
  /** Refcounted: subscribes to the SSE channel only while the panel is open. */
  watch(): () => void;
}
```

`watch()` is what keeps FR-019 honest on the client side — the provider opens the SSE stream on the first watcher and closes it when the last one goes away, so a closed panel costs nothing on either side of the wire.

Live state arrives through the existing `useAgentEventStream` hook. No polling.

---

## API client additions — `apps/web/src/api/client.ts`

```ts
export function fetchPowerState(): Promise<PowerState>;
export function setPowerLimit(limitPercent: number): Promise<PowerState>;
export function powerEventsUrl(): string;
```

All three use the existing typed wrappers (`request` / `requestBody` → `assertOk`); `powerEventsUrl` follows the established `${agentUrl}/api/power/events?token=…` form.

---

## Telemetry — FR-024

Two new names on the constrained `AnalyticsEventName` union in `apps/web/src/analytics/events.ts`:

| Event | Properties |
|---|---|
| `power_panel_opened` | none |
| `power_limit_changed` | `{ limit_percent: number }` — the settled value after debounce, not every intermediate drag position |

`limit_percent` needs a range entry in the numeric-bounds map (`[20, 100]`). No machine-identifying detail is added, per FR-024.

---

## i18n keys — `apps/web/src/i18n.ts`

Both `en` and `uk` (the file carries the two blocks; `TranslationKey` is compile-checked, so a missing key fails the build rather than rendering a key name):

`powerControl`, `powerLimitAt`, `powerPanelTitle`, `powerLeverLabel`, `powerUsageActive`, `powerUsageIdle`, `powerUsageMeasuring`, `powerUsageUnsupported`, `powerUsageUnavailable`, `powerAgentOffline`, `powerAgentOutdated`, `powerThrottleUnsupported`, `powerLimitFailed`, `powerScaleMark`.

---

## UI test matrix

`tests/power-panel.test.tsx` (jsdom, via `// @vitest-environment jsdom`), using `PowerContextOverride` to drive states:

| Case | Expected |
|---|---|
| Button renders in the header | Present, labelled, `aria-expanded="false"` |
| Limit below 100 | Button carries the reduced-limit indication |
| Click | Panel opens, focus enters, `aria-expanded="true"` |
| `Escape` | Panel closes, focus returns to the button |
| Lever roles | `role="slider"`, correct `aria-valuemin/max/now/orientation` |
| `↑` / `PageUp` / `Home` / `End` | +1 / +10 / 20 / 100 |
| Drag across the track | Value follows; one debounced request, not many |
| `setLimit` rejects | Lever returns to the previous value; error surfaced |
| `availability: 'ok'` + active | Percentage rendered |
| `availability: 'warming-up'` / `'error'` / `'unsupported'` | No percentage anywhere in the output |
| Agent offline | Offline copy, stored position shown, lever still movable |
| Agent offline, lever moved, then reconnect | The held value is posted once on reconnect (FR-021) |
| Contract too old | Outdated copy, lever disabled |
| Panel closed | `watch()` teardown ran — no live subscription remains |
