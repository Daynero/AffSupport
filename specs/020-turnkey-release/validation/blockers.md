# External acceptance blockers

Updated 2026-09-12. These are not implementation gaps: every named piece of code
exists and its behaviour is covered. What is missing is evidence that can only
come from a machine, an account or a commit that this run does not have.

| Tasks                 | Required external evidence                                                       | Current fact                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T015–T016, T066       | Merged G0 constitution ratification commit                                       | Git history contains constitution v1.0.0 ratification only; v2.0.0 is still an uncommitted working-tree amendment prepared on 2026-09-09. The two gate tasks are deliberately unstarted: changing the release gate before its governing amendment is in the repository is the one thing G0 exists to prevent.                                                            |
| T021 (evidence), T062 | Real isolated packaged beta login/entitlement journey and three sandbox releases | `scripts/verify-beta-runtime.mjs` is implemented and wired into `beta:verify`. It could not be executed here: a beta agent already holds port 43140 on this host, and the journey refuses to drive or stop somebody else's environment. No sandbox credentials or remote targets are configured either.                                                                  |
| T051 (consumer), T061 | Registered supervised bridge consumer                                            | The protocol, durable outbox and process transport are implemented and tested against a fake persistent bridge. No bridge is registered on this host, so `scripts/release-acceptance.mjs` fails closed on `AGENT_BRIDGE_UNAVAILABLE`. A seam with no functioning consumer is not a completed handoff.                                                                    |
| T063                  | Measured arm64 Mac with **8 GiB**                                                | This host is a MacBookAir10,1 (M1) with **16 GiB**. Its real measurements are recorded in `validation/resources.md` and are labelled with that host; they must not be read as the 8 GiB target's numbers.                                                                                                                                                                |
| T064                  | Same-scenario manual token baseline                                              | **Waived by the owner on 2026-09-12**: no with/without measurement will be taken. The owner will judge the difference from the next real release. `releaseMetrics` still keeps `modelTokens` null and counts handoffs separately, so nothing in the code claims a saving that was not measured. SC-006's ≥90 % figure therefore remains unproven and must not be quoted. |
| T065                  | Full serial `verify` and `verify:release` after resource admission               | Not run. The owner's standing instruction for this machine is that the full verification command is not to be launched here; it needs a host that can afford it, run with `nice -n 15` and `SOTY_VERIFY_SERIAL=1`. Targeted suites were run instead and their results are recorded per story.                                                                            |

Do not replace any row with a local boolean, fake digest, skip flag or manually
written success record. Each task remains open until its named evidence exists,
except where the owner has explicitly waived the measurement above — a waiver
records that nobody will measure it, never that it passed.

## Owner's decision, 2026-09-12

The owner accepts a simplified implementation and will not run comparative
measurements: the runner is to be exercised on the next real release, with fixes
made as they surface. That decision closes T064 as waived and changes how T062
should be read — the three isolated sandbox rehearsals are no longer a
precondition the owner intends to satisfy before using the runner. The technical
fact is unchanged and worth stating plainly: the first real run will be the
first time this sequence has executed end to end against real destinations.

## What the installed probe changes

One blocker did clear: the resource probe is now built, installed and verified on
this host (`release/automation/probe/ResourceProbe`, digest
`570e3e33…04f1cbce`), so probe-dependent behaviour is measured rather than
assumed. The lease server likewise runs for real in the integration suite. The
remaining T061 dependency is the bridge alone.
