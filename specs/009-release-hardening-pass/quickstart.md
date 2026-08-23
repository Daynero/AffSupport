# Quickstart — Validating the Release Hardening Pass

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Contracts**: [contracts/](./contracts/)

This is the validation guide: how to prove each user story actually works, on both platforms. It is not an implementation guide — that is `tasks.md`.

Sections map to user stories. Each names its prerequisites, what to run, and what must be true. Run §0 before anything else.

---

## 0. Prerequisites and the reproduction pass

### Prerequisites

| Need | For | If absent |
|---|---|---|
| Node at the version in the repo's version file | everything | nothing works |
| A real Windows machine or runner | §1W, §2W, §3 | the platform half of Stories 1–3 cannot be validated; source-text assertions written on a Mac do **not** satisfy a platform requirement |
| Container runtime | the database gate in §3 | that one gate skips with a named reason |
| A browser | §4, §7 | the interface stories cannot be validated |
| Test signing identities | §5 signing | the chain is proven with test credentials; real ones are a substitution, not a rebuild |

### The reproduction pass — do this first

The audit is explicit that **nothing in its interface section was observed in a browser**. Before building anything against those findings, reproduce them. Budget an hour.

1. Start the beta stack. Open the compressor. **Kill the local app for five seconds**, then restart it.
   - *Expected today (D1)*: the page is replaced by a "Download Soty" dialog with no way to close it, and the queue view is gone.
   - *Record*: what actually happened, in the audit file, replacing the "inferred" label with an observation.
2. Open the workspace in **two tabs**, then open a landing preview in one of them. Start a compression. Try to stop it.
   - *Expected today (D10)*: with enough streams open, the stop request never completes. Count the open connections in the browser's network panel — the prediction is that the seventh never opens.
3. Start a compression, and while a request is in flight, watch the progress bar.
   - *Expected today (D3)*: progress occasionally jumps backwards.

**If any of these does not reproduce, say so and update the audit before writing code.** A fix for a bug that does not exist is worse than no fix.

---

## 1. Story 1 — interleaved work behaves predictably

### Automated

```bash
npm run verify:release -- --gates=e2e
```

Runs the interleaving suite against a **real out-of-process local app**, with stub tools by default (`lifecycle` profile — no multi-gigabyte downloads, seconds per scenario).

**Must be true:**

- At least one scenario has **≥20 steps across ≥3 tools** — asserted as a countable expression, which is why the sequence is data.
- After **every** step, the reported state and the machine observation agree. A disagreement fails immediately, naming the step index.
- Within 5 s of every stop: no process from that job is alive, no partial output remains.
- Within 10 s of every stop: Soty's share of the machine is ≤2%.
- A survivor reported as **"left suspended"** is a distinct failure from "left running" — they are different bugs and must never be reported as the same one.

### Manual, once per platform

The four walkthroughs spec 008 left open (T084–T087) are the acceptance content here. The Windows one is the important one — its own task list calls the orphaned-suspended-process check "the most consequential failure mode in the design", and it has never been automated.

1. Start a batch compression. Stop it halfway.
2. Immediately start a transcription.
3. Return to the compressor and re-run one stopped file **while the transcription is still going**.
4. Stop everything. Quit the app. Reopen it.
5. Repeat, but **force-quit** at step 4 instead.

**Must be true**, checked with the system's own process viewer, not the app: nothing from Soty is running after step 4; no truncated output files sit next to the sources; every interrupted job reads as *interrupted*, not *failed* and not *running*; and step 5 behaves the same as step 4 (this is the FR-003a half — the crash case is the one users actually hit).

### 1W. Windows specifics

Everything above, plus: kill the local app **mid-encode** from the task manager, then check for suspended survivors. A suspended orphan is present in the process table and answers a liveness check — this is exactly why the probe has a separate suspension check, and it is the check most likely to catch a real regression.

---

## 2. Story 2 — power is one shared budget that never lies

```bash
npm run verify:release -- --gates=e2e
```

**Must be true:**

- With any combination of tools running at a reduced limit, combined consumption — measured as a share of total capacity across all cores, sampled once a second — averages within 10 points of the limit over 60 s, and no 10-second stretch exceeds it by more than 20.
- Changing the lever affects work **already running**, not only work started afterwards.
- A tool that decides how many units to run side by side reduces that number when the limit drops.
- Output at a reduced limit is equivalent to output at full power — same duration, same dimensions, decoded content indistinguishable within the encoder's own tolerance. **Not byte-identical**: multi-threaded encoding is not deterministic and the limiter suspends processes, so byte equality was never achievable and is not the criterion.

### 2W. The degradation case — Windows only, and it is the point

Force the suspend mechanism to fail (exhaust its retry budget), then open the power panel.

**Must be true**: the panel reports the limit as **unenforceable**. Today it keeps showing an active lever, keeps signalling to no effect indefinitely, and silently stops prioritising estimates for the rest of the session. That "unsupported" state was built in spec 008 and is currently unreachable even when it should be reached.

---

## 3. Story 3 — one command

```bash
npm run verify            # fast, target under 2 min (measured baseline ≈ 41 s)
npm run verify:release    # full, target under 10 min (measured baseline ≈ 7–8 min)
```

**Must be true on success:**

- **At most 20 lines** of output.
- `verification-result.json` carries the full structured result.
- `skipped_tests` is **0** on the release runner; on any other runner every skip carries a named reason and is counted.

**Must be true on failure** — verify by deliberately breaking one thing in each category (a formatting violation, a lint error, a type error in a **test** file, a failing assertion, an out-of-scale style value, an unused translation, a high-severity dependency advisory):

- At most 100 lines, with the failing gate and its subject in the **first 10**.
- The excerpt is the underlying tool's own words, truncated — never re-formatted.
- Exit code 1.

**Must be true of the automation:** every pull request runs the static, macOS suite, Windows suite and build jobs; all four are required to merge; a failure blocks it.

**A deliberate self-test:** add a state to any status union without adding a driver.

- Expected: **two** failures — one at type-check (the table is incomplete) and one in the suite (no driver). That double failure *is* SC-003.

---

## 4. Story 4 — the interface tells the truth

For each tool page, with one tab and then with three:

1. Interrupt the connection for **2 s**, then for **10 s**.
2. Restart the local app so re-pairing is required, with unsaved text in the transcript editor.
3. Fire a mutation and a live update at the same moment.

**Must be true:**

- The user stays on their page. Unsaved input survives. No installation or download instructions ever appear to someone who has the app installed.
- The 2-second interruption produces **no visible disconnect at all** — it is inside the grace period.
- Every dialog can be dismissed. There is no state in which a dialog has no exit.
- Progress stops presenting itself as live while disconnected: no advancing bar, no ticking timer.
- Progress never moves backwards within one run. (Re-running legitimately restarts from zero — that is not a violation.)
- **Every tool page behaves identically.** Today the landing pages and the compressor do opposite things on the same event; that difference must be gone.
- With three tabs, re-pairing happens **once** and all three converge.
- Any progress shown to another member is a real measurement. A hardcoded placeholder value must not exist anywhere.

---

## 5. Story 5 — hardened

### Adversarial suite

```bash
npm run verify:release -- --gates=e2e
```

At least **30 attempts against a real running local app**, 100% refused:

| Category | Attempts |
|---|---|
| Origin | hostile origin, no origin, spoofed host, rebound name |
| Token | forged, replayed, expired, in a query parameter, repeated parameter (yields an array — today this reaches a raw comparison) |
| Paths | traversal, symlink swapped between grant and read, credential-store paths, network paths, extended-length prefixes, short (8.3) names, case-collision variants |
| Uploads | oversized, truncated, over the file-count budget, over the byte budget, over the time budget, an entry escaping its destination |
| Backend | the unauthenticated range path with a forged, replayed, expired, or wrong-team ticket |

**Also assert the positive suite** — this is what stops the path ledger from shipping as "the queue empties itself after an upgrade":

- pick → restart → resume works
- drag-and-drop → restart → resume works
- the chosen output folder is still writable after a restart

### Leak check

Inspect everything transmitted and everything logged.

**Must be true**: zero file names, file paths, or user content — in telemetry, diagnostics, error payloads, or any log line. **Showing the user the names of files they added is the product working correctly** and is explicitly not covered.

### Signing

On a **clean** machine, download and open the installer for each platform.

**Must be true**: the operating system verifies the publisher and the app opens with no instruction to bypass a warning. Until real credentials exist, the equivalent check runs against test identities and the only remaining step is substituting them.

### Content policy

Walk pair → compress → open a preview → sign in.

**Must be true**: **zero policy violations in the console.** This is not optional — a policy mistake is invisible to unit tests and total in production.

---

## 6. Story 6 — faster

```bash
npm run verify:release -- --gates=e2e
```

Compare against baselines recorded **before any change**:

- Initial download falls by ≥40%, **and each of the three largest individual pieces falls by ≥30%** — so no target is met by deleting one constant while the rest stay untouched.
- Time to interactive on a throttled mobile profile improves by ≥30%.
- With 200 queued items receiving live updates: interaction stays inside budget, and items whose data did not change **do not re-render** (assert render counts, not impressions).
- A transcript of several thousand segments opens promptly and scrolls smoothly.
- Images reserve their space before loading — no layout shift in any gallery.
- A reduced-motion preference disables decorative animation.

---

## 7. Story 7 — one consistent surface

```bash
npm run verify:release -- --gates=static   # styles + translations
npm run verify:release -- --gates=e2e      # accessibility sweep
```

**Must be true:**

- Zero references to undefined theme values; zero values outside a defined scale. Note two scales — text size and stacking order — **do not exist yet and must be created** before the rule is meetable.
- Every route × 2 themes × 2 languages reports zero blocking or severely impairing accessibility issues.
- Every interactive control is operable by keyboard alone. Check specifically: the focus ring is visible against every light surface (today's global ring fails the contrast requirement everywhere), range selection in the queue works without a mouse, and the segmented control responds to arrow keys.
- Every dialog goes through one implementation — including the two currently hand-rolled and the two currently delegated to the operating system.
- Zero unused translations; counts follow each language's plural rules; no message is translated by matching English wording.
- The page before the app loads matches the user's language and theme.

**Expect a large initial violation set.** Land the sweep in report-only mode with a committed baseline, then drive it to zero — the same ratchet shape as coverage.

---

## Definition of done

- Every section above passes on **both** platforms.
- Every defect recorded in the audit at spec approval is resolved or explicitly accepted with a stated reason.
- The reproduction pass in §0 has been done and the audit's confidence labels updated to reflect what was actually observed.
