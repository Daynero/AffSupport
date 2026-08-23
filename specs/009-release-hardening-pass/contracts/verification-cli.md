# Contract — Verification Command

**Entry point**: `scripts/verify-all.mjs`
**Invocations**: `npm run verify` (fast) · `npm run verify:release` (full)
**Serves**: FR-014, FR-014a, FR-015, FR-016, FR-018, FR-022, SC-005, SC-006, SC-007.

One implementation, one flag. The two forms differ **only** in which gates run — never in how a result is reported. That is what makes FR-014a structurally true rather than aspirational.

---

## Invocation

```
node scripts/verify-all.mjs --form=fast|release [--json] [--gates=<group>] [--update-coverage-baseline]
```

| Flag | Meaning |
|---|---|
| `--form` | Gate list. Required. |
| `--json` | Emit the result envelope to stdout instead of the human summary. |
| `--gates` | Run one named phase group. Used by CI jobs to split work across runners. |
| `--update-coverage-baseline` | Rewrite the committed baseline. Release form only. |

Exit code `0` on success, `1` on any gate failure. The full result is always written to `verification-result.json` (gitignored) regardless of flags, so nothing is ever lost — only unread.

---

## Phases

Parallel **within** a phase, strictly serial **between** phases.

| Phase | Gates | Fast | Release |
|---|---|---|---|
| 0 — seed | build shared | ✓ | ✓ |
| A — static, read-only | format · lint · 6 typecheck projects · styles · i18n · dependency audit | ✓ | ✓ |
| B — suite, **exclusive** | the test suite (+ coverage in release) | ✓ | ✓ |
| C — builds & contract | build web · build agent · release contract · web env · team contract | ✗ | ✓ |
| D — out-of-process, **exclusive** | end-to-end · database · accessibility sweep · review app | ✗ | ✓ |

**Phase B is exclusive for a specific, recorded reason** (finding A17): the suite rebuilds the shared package's committed output and rewrites a tracked migration while other phases would be reading both. It is also pointless to overlap — the suite already saturates every core. The lasting fix is an output-directory flag on the generator so the test writes into a temp directory; until then, exclusivity is enforced in the aggregator rather than by convention.

**Measured budgets** at commit `78f1d88`: fast ≈ 41 s against a 120 s ceiling; release ≈ 7–8 min against 10. The accessibility sweep is the only gate at real risk of exceeding it, so every gate carries a `timeout_ms` that **fails the gate rather than hanging the command**.

---

## Result envelope

Extends the existing analytics envelope — `ok`, `command`, `generated_at`, `data`, and the `{ ok: false, command, error }` twin — verbatim. Adds `form`. **Drops `period`**, because this is not a time-window report and a null period would misrepresent a contract the constitution calls stable.

The full shape is in [data-model.md §6](../data-model.md).

```json
{ "ok": true, "command": "verify", "generated_at": "…", "form": "release",
  "data": { "duration_ms": 431200,
            "totals": { "gates": 14, "passed": 14, "failed": 0,
                        "tests": 1403, "skipped_tests": 0,
                        "skip_reasons": {}, "coverage_lines": 71.2 },
            "gates": [ { "id": "lint", "ok": true, "duration_ms": 5512 } ] } }
```

```json
{ "ok": false, "command": "verify", "generated_at": "…", "form": "fast",
  "error": "typecheck:tests",
  "data": { "…": "…",
            "failure": { "gate": "typecheck:tests",
                         "subject": "tests/queue.test.ts(88,7): TS2345 …",
                         "excerpt": ["…"] } } }
```

---

## Output budget

| | Cap | Rule |
|---|---|---|
| Success | **20 lines** | 1 header, ≤15 gate lines, blank, 2 totals lines. The aggregator asserts the cap and collapses the gate block to one line if a future list would exceed it. |
| Failure | **100 lines** | Line 1 names the form and the failing gate. Line 2 is the one-line subject. Lines 3–8 are the remaining gate statuses. Then a per-gate excerpt, capped at 88 lines. |

**The aggregator never re-formats what a gate said about itself — it truncates.** That is what keeps "sufficient to act on without re-running" honest: the excerpt is the tool's own words.

Test-suite noise is removed by the runner's own passed-only silencing, measured to eliminate 100% of the known stderr noise while still emitting logs from *failing* tests. **Named-file filtering was rejected outright** — an allowlist silently stops working on rename and can suppress a genuine error.

---

## Skip semantics

A requirements helper probes at **collection time** (the availability flag is assigned in a before-all hook today, so a collection-time condition would otherwise skip everything). Requirements are encoded in the suite title:

```
describe('real encoder fidelity [needs: ffmpeg,ffprobe]', …)
```

| Rule | |
|---|---|
| Reasons are read back from the runner's JSON report | No ledger file, no global state, no reporter plugin. |
| **A skipped test with no requirement marker fails the run** | On every runner. This is SC-007 in one line. |
| Release mode makes the probes **throw** | So a release runner missing a binary fails loudly naming it, rather than quietly reporting zero skips because nothing ran. |
| A bare early return inside a test callback is a **lint error** | The constitution has named this anti-pattern since ratification and it is still present in fourteen places. A rule is the only thing that ends that. |

---

## Coverage

Measured with the V8 provider, `all: true` — **non-negotiable**, because without it the ~50 modules no test imports simply do not appear and the baseline is a lie.

Enforced **by the aggregator, not by runner thresholds**, because the rule is not a single floor:

1. **Critical modules first**, independently of the ratchet — a listed run-state module below its absolute floor fails even if the global rose. Membership is **derived** by walking the import graph from the run-state entry points; adding a state module without listing it fails the gate.
2. **Then the ratchet** — global must not fall; no file may fall beyond tolerance; a baselined file that vanished without its module being deleted fails.

Expect the first measured figure to be low. That is the correct baseline, and the spec's Assumptions say so.

---

## CI mapping

| Job | Runner | Invocation |
|---|---|---|
| `static` | Linux | `--form=fast --gates=static` |
| `test-macos` | macOS | `--form=fast --gates=suite` + coverage |
| `test-windows` | Windows | `--form=fast --gates=suite` |
| `build` | macOS + Windows | `--form=release --gates=build` |
| `e2e` | macOS | `--form=release --gates=e2e` |

Required for merge: `static`, `test-macos`, `test-windows`, `build`. The end-to-end job runs on push to the default branch and on labelled pull requests only — the single biggest minutes lever, and the right trade, because that harness needs a full build plus real binaries and its failures are rarely local to one change.

Every workflow reads the Node version from a version file; a test asserts no workflow pins a literal version.

**The hand-maintained fifteen-file Windows test list is deleted, not fixed.** The whole suite runs there; tests that genuinely cannot become named skips. That list is a workaround for the missing skip mechanism, and once the mechanism exists its reason for being is gone.

---

## Self-verification

The aggregator is the single point of failure for every gate, so it has its own test:

- Each gate id appears in exactly one form's list.
- A stubbed failing gate produces `ok: false` with that gate's id in `error`.
- The 20-line and 100-line budgets hold.
- The failing subject appears within the first 10 lines.
