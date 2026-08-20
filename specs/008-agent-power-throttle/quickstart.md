# Quickstart: Validating the Local Agent Power Throttle

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Contracts**: [contracts/](./contracts/)

How to prove the feature actually works — automated gates first, then the manual checks that only a real machine under real load can settle. Every scenario names the requirement or success criterion it discharges.

---

## Prerequisites

- Node 22, repo dependencies installed
- FFmpeg and ffprobe resolvable by the agent (`GET /health` reports `ready: true`)
- A test video of at least ~2 minutes — short clips finish before throttling is observable
- A system monitor for the cross-check: **Activity Monitor** on macOS, **Task Manager** → Details on Windows
- For the cross-platform scenarios: both a macOS and a Windows machine

```bash
npm run build -w @video-compressor/shared   # contract first — dist is committed (Principle II)
```

---

## 1. Automated gates

Run from the repo root. These must pass before any manual validation is meaningful.

```bash
npm run format:check
npm run lint                    # also enforces the child_process import ban (FR-008)
npm test                        # builds shared, then vitest run
npm run build -w @video-compressor/agent   # CI never builds the agent — carry this gate manually
npm run build -w @video-compressor/web
```

Feature-scoped runs while iterating:

```bash
npx vitest run tests/power-governor.test.ts \
               tests/power-routes.test.ts \
               tests/power-persistence.test.ts \
               tests/power-sampler.test.ts \
               tests/power-process-tree.test.ts \
               tests/power-spawn-coverage.test.ts \
               tests/power-panel.test.tsx
```

**Expected**: all green. `tests/power-spawn-coverage.test.ts` failing means a heavy spawn site was added or missed outside the managed seam — that is the FR-008 regression guard doing its job, not a flaky test.

---

## 2. HTTP contract, by hand

Start the agent and pair a browser session so you have a token (the routes are entitlement-gated by design — [research R7](./research.md#r7--entitlement-gating-and-the-degraded-ui-state)).

```bash
npm run dev -w @video-compressor/agent
```

```bash
TOKEN=<session token>
BASE=http://127.0.0.1:43120
ORIGIN=http://127.0.0.1:5173

# Fresh agent → unrestricted
curl -s -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" $BASE/api/power
# → {"limitPercent":100,"mode":"unrestricted",...}

# Set 40%
curl -s -X POST -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"limitPercent":40}' \
     $BASE/api/power/limit
# → 200, limitPercent 40, mode "limited"

# Out of range clamps, it does not fail
curl -s -X POST … -d '{"limitPercent":5}'    # → 200, limitPercent 20
curl -s -X POST … -d '{"limitPercent":500}'  # → 200, limitPercent 100

# Malformed rejects with a machine code
curl -s -X POST … -d '{}'                    # → 400 {"error":"POWER_LIMIT_INVALID"}

# Live stream
curl -N "$BASE/api/power/events?token=$TOKEN" -H "Origin: $ORIGIN"
# → a data: frame immediately, then roughly one per second
```

**Discharges**: FR-003, FR-006, FR-011, FR-015, FR-016 and the route matrix in [contracts/agent-http.md](./contracts/agent-http.md#route-level-test-matrix).

**Also check**: `curl -s $BASE/health | grep power` → `toolContracts.power` is `1` (FR-022's mechanism).

---

## 3. Throttling a running job — the core scenario

**Discharges**: FR-007, FR-009, FR-010, SC-001, SC-002, SC-003.

1. Set the limit to 100. Start a compression of the long test video.
2. Watch the system monitor. Note FFmpeg's CPU share and Soty's figure in the panel — they should broadly agree (the panel counts the agent plus its children, so it reads slightly higher).
3. With the job still running, pull the lever to **20%**.
4. **Expected within 5 s**: FFmpeg's share drops toward 20% of total capacity. The job keeps running — progress continues, no error, no restart. The panel's readout follows the drop.
5. Leave it for 30 s and average the reading. **Expected**: ≤ 30% (limit + the 10 pp tolerance of SC-001).
6. Push the lever back to **100%**. **Expected**: consumption climbs back within 5 s and the remaining work speeds up.
7. Let the job finish. **Expected**: it completes successfully.
8. Re-run the same source at 100% and compare outputs:

```bash
shasum -a 256 throttled-output.mp4 unthrottled-output.mp4   # macOS
certutil -hashfile throttled-output.mp4 SHA256              # Windows
```

**Expected**: identical hashes. Only elapsed time differs (SC-003). A mismatch means throttling changed encoder behaviour — a genuine defect, not a tolerance.

---

## 3a. Living alongside a throttled Soty

**Discharges**: SC-005.

With the limit at 20–40% and a long job running, spend a normal working session on the same machine: browse, edit code, join a video call. Repeat across several sessions and different limits.

**Expected**: no perceived system-wide slowdown in at least 9 of 10 sessions. This is the criterion the whole feature exists for, and it is the one that cannot be settled by a number in a monitor — it has to be felt.

---

## 3b. Throttling must slow work down, never break it

**Discharges**: FR-010, and the two failure modes that would otherwise reach users as unreproducible bugs.

**Wall-clock deadlines** ([research R12](./research.md#r12--wall-clock-timeouts-under-a-duty-cycle)):

1. Set the limit to **20%**.
2. Render a landing preview that takes 20–30 s at full power.
3. **Expected**: it completes, just slowly. A `RENDER_TIMEOUT` here means `RENDER_TIMEOUT_MS` was not scaled — the render simply outran a 90 s wall-clock budget it never had a chance to meet.
4. Repeat with a team landing-gallery render (`RENDER_TIMEOUT` watchdog) and a large folder scan (`FS_OP_TIMEOUT_MS`).

**Suspension ownership** ([research R11](./research.md#r11--one-owner-of-suspend-state)):

5. With the limit at 20% and a compression running, add files so estimates are queued. **Expected**: estimates still jump the line and the encode genuinely pauses for them — the behaviour that exists today. If estimates crawl, the duty cycler is resuming a process the queue deliberately stopped.
6. With the limit at 20% and a compression running, **cancel the job**. **Expected**: it stops promptly and cleanly. A cancel that takes the full 2 s escalation and leaves a truncated output file means `SIGTERM` was delivered to a suspended process that could not handle it.

---

## 3c. Unrestricted must be indistinguishable from today

**Discharges**: FR-011, [research R13](./research.md#r13--unrestricted-must-mean-exactly-as-today).

With the limit at **100%**, capture the argv of a running encode and a running transcription:

```bash
ps -o args= -p $(pgrep -n ffmpeg)     # macOS
ps -o args= -p $(pgrep -n whisper)
```

**Expected**: no `-threads` / `-filter_threads` on the ffmpeg command line, and whisper's `-t` at its usual `max(4, cores - 2)` value. Compare against the same commands on a build without this feature — they must match exactly. A `-threads` flag appearing at 100%, or whisper jumping from 8 threads to 10 on a 10-core machine, means the default state is no longer the previous state.

---

## 4. One shared budget across tools

**Discharges**: FR-007, FR-008, SC-009.

1. Set the limit to **50%**.
2. Start a compression **and** a transcription at the same time.
3. Watch total Soty consumption.

**Expected**: the two together stay near 50% — **not** 50% each. This is the single most important observation in the whole validation; a reading near 100% means the budget is being applied per tool and FR-007 is not met.

Repeat across the tool set — landing optimizer, landing preview, image conversion, transcription media preview, team-workspace processing — confirming each is inside the ceiling with no per-tool setting anywhere in the UI.

### 4a. And only local processing

**Discharges**: FR-020.

With the limit at **20%**:

| Do this | Expect |
|---|---|
| Upload or download a large file through the team workspace | Transfer speed is unaffected — the limit governs local processing, not the network |
| Click around the app while a job runs | The interface stays responsive; the limit never throttles the UI or the agent's own request handling |
| Trigger any server-side/remote operation | Unaffected |

A transfer that slows to a crawl at 20% means something outside local processing was registered with the governor.

---

## 5. Persistence and cross-window agreement

**Discharges**: FR-011, FR-012, FR-023, SC-006.

1. Set 40%. Confirm `~/Library/Application Support/<app>/power.json` (macOS) or `%APPDATA%\<app>\power.json` (Windows) contains `"limitPercent": 40`.
2. Quit and relaunch the agent → `GET /api/power` still reports 40 (FR-011).
3. Reload the web app → the lever renders at 40, the button shows the reduced-limit state.
4. Open a second window. Change the limit in one. **Expected**: the other updates within a second, no reload (FR-023) — this arrives over SSE, not from browser storage.
5. Corrupt the store deliberately:

```bash
echo 'not json' > "<support dir>/power.json"
```

Restart the agent. **Expected**: 100% (unrestricted), one log line, no crash. The safe failure direction is full speed, never a mysterious 3% ([research R8](./research.md#r8--where-the-setting-lives-and-why-it-is-per-machine)).

---

## 6. The readout

**Discharges**: FR-015 – FR-019, SC-007, SC-010.

| Do this | Expect |
|---|---|
| Open the panel with nothing running | A near-zero figure and idle wording within 2 s |
| Start a job | The figure rises and keeps updating (≥ once / 2 s) |
| Move the lever | The figure follows within a few seconds without reopening the panel |
| Stop the job | The figure falls back toward idle |
| Load the machine with something **other** than Soty | Soty's figure stays low — it reports Soty's share, not system load |
| Stop the agent, keep the panel open | "Unavailable" wording, **no number** (FR-018) |
| Close the panel with a job running | The sampling probe stops — no `ps` / helper traffic (FR-019) |
| Watch the agent's own CPU with the panel open and nothing running | ≤ 1% of the system (SC-010) |

Verify the last one on macOS with `sudo fs_usage -f exec | grep ps` or simply by watching the agent process's own share in Activity Monitor.

---

## 7. Windows and macOS parity

**Discharges**: FR-014, SC-008.

Run scenario 3 on both platforms with the same source file and the same limit, on comparable hardware.

**Expected**: measured consumption within 15 pp of each other, and the lever, scale, and readout present and functional on both.

**Windows-specific checks** — this is where the new suspend helper lives ([research R3](./research.md#r3--suspending-a-process-on-windows)):

1. With the limit below 100 and a job running, Task Manager shows one extra `powershell.exe` — the resident suspend helper. It appears **only** when throttling is engaged.
2. Set the limit back to 100 and finish the job. **Expected**: no FFmpeg process is left suspended, and the helper is torn down.
3. Kill the agent **mid-job** while throttled (Task Manager → End task). **Expected**: no orphaned suspended FFmpeg. Confirm with `Get-Process ffmpeg` — nothing lingering. This is [data-model invariant 1](./data-model.md#invariants) and the most consequential failure mode in the design.
4. Regression check the existing path this repairs: run a compression, trigger an estimate, and confirm the encode is genuinely suspended during it — behaviour that was a silent no-op on Windows before this feature.

---

## 8. Edge cases

**Discharges**: the Edge Cases section of the spec.

| Scenario | Expected |
|---|---|
| Drag the lever rapidly end to end | Last position wins; lever and applied limit agree; one settled request, not one per pixel |
| Low-core machine (2–4 cores) at 20% | Work still progresses (FR-013). The *effective* share may exceed 20% — expected, see [research R10](./research.md#r10--keeping-throughput-non-zero-at-the-floor), not a defect |
| Agent not running, open the panel and move the lever | Panel opens, offline copy, no figure; the chosen value is retained and applied once the agent reconnects, not discarded (FR-021) |
| Agent predating this feature | "Not supported, please update"; no limit claimed to be in force (FR-022) |
| Queue several jobs, then lower the limit | All run in order under the limit; nothing dropped |
| Sleep/wake mid-job | Readout resumes, limit still enforced |
| Keyboard only, no mouse | Tab to the button, `Enter`, arrows/`PageUp`/`Home`/`End` on the lever, `Escape` to close (FR-004) |
| Screen reader | Lever announces as a slider with its value; the readout announces politely, not on every tick |

---

## 9. Time-to-task

**Discharges**: SC-004.

Ask someone who has not seen the feature: "make Soty use less of your computer." Time from that sentence to a confirmed change in the readout.

**Expected**: under 15 seconds, with no documentation.

---

## Definition of done

- [ ] Section 1 gates pass, including both workspace builds
- [ ] Section 3 shows the limit reaching running work within 5 s, byte-identical output
- [ ] Section 3a shows no perceived slowdown in ≥ 9 of 10 sessions
- [ ] Section 3b shows throttling slowing work without timing it out, estimates still jumping the line, and a clean cancel while suspended
- [ ] Section 3c shows a 100% argv identical to a build without this feature
- [ ] Section 4 shows two concurrent tools sharing **one** budget
- [ ] Section 4a shows transfers and UI responsiveness untouched by the limit
- [ ] Section 5 shows persistence, cross-window agreement, and safe corruption fallback
- [ ] Section 6 shows a live readout that never invents a number
- [ ] Section 7 passes on **both** platforms, with no orphaned suspended process on Windows
- [ ] Section 8 edge cases behave as tabulated
- [ ] Section 9 lands under 15 seconds
