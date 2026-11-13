# Native update data model

All persisted, bridge and HTTP input starts as unknown; exact schema/enum/bounds validation fails closed. Records are environment/installation scoped.

## CandidateDescriptor

Schema, candidate ID (verified descriptor digest), stable channel, target, version/build/source, minimum OS, immutable HTTPS URL, byte length, SHA-256, Sparkle EdDSA archive signature, trusted publisher and manifest snapshot binding. All are covered by canonical shared manifest signature. Native derives candidate only from signature-verified payload bytes. Missing metadata means legacy fallback, not guessed fields. Target selection follows installed runtime/package identity, not browser UA.

## InstallationIdentity

Opaque installation ID, environment/channel, current verified package target/build/source, host protocol/capability and boot ID. Local installation path/ownership never enter telemetry. Runtime x64 does not imply physical Intel hardware.

## UpdateIntent / Attempt

Native-owned schema/revision, installation+intent+attempt+parent IDs, immutable candidate/source/target identities, consent timestamp, current/last proven stage, bounded result/code and source/target boot IDs. One accepted operation per installation; replay returns same attempt. Another candidate cannot overwrite active state.

```text
offered → preparing → prepared → consented → draining → drained → install_committed
                                                        ↘ deferred
install_committed → replacement_started → replacement_committed → relaunch_requested
                  → target_started → native_ready → ui_visible
```

`install_committed` is accepted installer handoff, not proof of replacement. Before it defer/cancel releases the owning barrier; after it cancellation is not promised. Every later stage needs its own receipt. Unknown replacement/relaunch is reconciled before retry. Disconnect has no success transition. Outcomes: prepared-without-consent, deferred, cancelled, failed, recovering, unknown, native_success, ui_success; UI augments native outcome.

## WorkloadBarrierReceipt

Agent-owned schema, IDs/candidate/source boot, admission epoch, quiescing/drained/released/failed, permit+busy counts, durable-flush revision summaries, closed code. `drained` requires schedulers paused, permits=0, canonical busy=0, successful durable flushes and unchanged epoch. Stale boot/owner/candidate receipts cannot authorize handoff. Defer releases only its own epoch. Native requires fresh receipt at commitment.

## ActivationReceipt

Native/helper-owned append records bind attempt/candidate/installation/revision, stage, actual package identity, boot IDs and bounded code. New runtime proves exact identity/readiness before task admission; old runtime/another copy cannot acknowledge success. Web separately acknowledges visibility once. First target start or possible data mutation prohibits automatic downgrade.

## Persistence / retention

Single native writer under installation lock, separate agent receipt writer. Owner-only directory, bounded cache/history, atomic write+flush+rename and parent durability proof. Corrupt/truncated/unknown schema produces recovery/unknown; never reset to invented successful history. Typed retention/cache limits are fixed with implementation and checked in tests; active/uncertain recovery evidence cannot be deleted as stale cache. Fault tests include disk-full and flush failure.

Telemetry is a bounded projection, never installation authority. No raw paths, Apple identities, keys, user/task content or provider payloads. Typed identity fields respect event length limits; journal emission is not proof of a durable stage.
