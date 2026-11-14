# Native recovery and update safety follow-up

The combined integration source passed11569 tests but failed coverage ratchets.
This follow-up adds behavior-focused native tests without lowering any floor.
Only one product change is included: a reproduced native-helper ownership bug.

## Reproduced helper release bug

Before the fix:

```bash
nice -n 15 npx vitest run tests/power-governor.test.ts \
  --maxWorkers=1 --no-file-parallelism -t 'retains a new native helper adoption'
```

The test failed: after releasing the first adoption, registering the same PID
again and invoking the first release callback twice, the newer adoption was
removed (`expected [1234], actual []`). The release closure now checks the exact
captured entry identity. It cannot release a later adoption or a managed child.
No signal routing, resource ceiling or caller ownership protocol changed.

All native test PIDs are synthetic. Platform pause/resume/priority seams and
process-table probes are replaced with explicit test callbacks. Tests cover
limited/unrestricted ownership, duplicate/invalid registration, stale release,
resume on release/shutdown and failures in root/descendant signaling or discovery.
No test signals a host process or invokes real credential storage.

## Native behavior checks

- Journal flush joins pending commits, permits a missing file, rejects unconfirmed
  reads/close failures and failed update checks. Disk-full/I/O replacement failures
  retain the previous committed owner, remove staging and require a successful
  later write before update flushing can proceed.
- Vault flush joins encrypted writes. Default platform-store wiring is tested with
  a mocked credential provider; only a43-character key reaches it. Cyclic input and
  failed atomic replacement preserve previous ciphertext; a later retry succeeds.
- Recovery routes distinguish manual/automatic admission, capability/update gates,
  invalid inputs, scoped retry/status/removal and safe closed failure codes.
- Native update configuration requires the packaged Mac host, bounded private
  endpoints/key and valid launcher identity. Helper discovery uses same-user,
  realpath-bound Sparkle executables and their descendants, excluding escaped,
  exited and foreign-user/installation processes. Failed discovery remains unknown.
- Strict landing-settings persistence reports an unwritable target; the legacy
  best-effort path remains nonfatal and does not overwrite the blocking file.

## Commands and results

```bash
nice -n 15 npx vitest run \
  tests/native-restitch-journal.test.ts tests/native-restitch-vault.test.ts \
  tests/recovery-enrollment-errors.test.ts tests/native-update-platform.test.ts \
  tests/platform.test.ts tests/landing-settings-behaviour.test.ts tests/power-governor.test.ts \
  --maxWorkers=1 --no-file-parallelism --coverage \
  --coverage.reportsDirectory=/tmp/soty-recovery-coverage \
  --coverage.include=apps/agent/src/team-bridge/native-restitch-journal.ts \
  --coverage.include=apps/agent/src/team-bridge/native-restitch-vault.ts \
  --coverage.include=apps/agent/src/team-bridge/recovery-enrollment.ts \
  --coverage.include=apps/agent/src/power/governor.ts \
  --coverage.include=apps/agent/src/platform/platform.ts \
  --coverage.include=apps/agent/src/landing/store.ts
```

143 passed,0 failed,0 skipped. The initial new journal test incorrectly expected
APP_UPDATE_BUSY after a rejected write; corrected to assert the original closed
write failure, which intentionally propagates from the pending write barrier.

```bash
nice -n 15 npx vitest run tests/power-*.test.ts tests/sleep-wake.test.ts \
  tests/queue-pause-platform.test.ts --maxWorkers=1 --no-file-parallelism \
  --coverage --coverage.reportsDirectory=/tmp/soty-governor-coverage \
  --coverage.include=apps/agent/src/power/governor.ts
```

194 passed,0 failed,2 named `SOTY_POWER_LOAD` opt-in skips. This covers the complete
existing governor/resource-control tests, not just the new helper tests.

| Module                  | Previous combined measure |                          Focused measure | Unchanged requirement |
| ----------------------- | ------------------------: | ---------------------------------------: | --------------------- |
| native-restitch-journal |                    86.25% |                                     100% | 93.27% baseline       |
| native-restitch-vault   |                    90.13% |                                   99.34% | 95.53% baseline       |
| recovery-enrollment     |                    54.65% |                                     100% | 57.57% baseline       |
| power/governor          |                    90.83% |              98.72% with all power tests | 95% critical floor    |
| platform/platform       |                    65.85% | 36.59% focused;72.19% supplemental union | 69.41% baseline       |
| landing/store           |                    93.33% |   96.66% focused;100% supplemental union | 96.42% baseline       |

The last two supplemental unions use the prior full coverage and new focused
coverage for byte-identical product files. They diagnose likely gate recovery;
they are not a fresh combined gate proof. The governor changed and is measured
fresh with the complete power suite. Final combined proof belongs to integration.

Targeted ESLint over the changed product/test files and
`nice -n 15 npx tsc -p tsconfig.check.json --noEmit` both passed. No skip/floor or
product exception was introduced. Full release gates remain with the coordinator.
