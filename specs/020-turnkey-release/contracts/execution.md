# Execution contract

## Adapter

inspect → ready/alreadyMatching/blocked; execute → observed/unknown/failed; reconcile → matching/provenAbsent/pending/conflicting/ambiguous; verify → valid/invalid. Persist prepared identity before execute and observed evidence after. Exit0 is not proof of published effect.

## Canonical mapping

| Stage          | Entry and integration                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| Prepare/freeze | deterministic version projection; verify:release candidate context; known-file commit; fast-forward refs        |
| Beta           | beta:package + beta:verify; explicit runtime/env; package SHA/dirty/digest and actual smoke                     |
| Readiness      | release:check candidate mode; rebuild production after beta                                                     |
| macOS          | package:mac / package:dmg / sums; no same-version rebuild after tag                                             |
| Windows build  | release-windows.yml publish=false; pinned SHA/correlation; reusable release:watch                               |
| Publish        | exact target gh release create and macOS asset; Windows publish=true only                                       |
| Manifest       | download both published assets; streaming hash/sign; final release/published digest gates; manifest-only commit |
| Manifest beta  | sync refs and fresh packaged verification on manifest SHA                                                       |
| Deploy/live    | deploy:web retains all gates; deployment source/output marker; live signature, both digests and refs            |

Candidate mode is named phase validation, not skip flag. Default release validation final. Governed canonical docs updated alongside implementation; affected gate implementation and real integration blocked until separate ratification.

## Reconciliation identities

Git: expected parent/tree/SHA and target refs. Windows: repository/workflow/releaseId/mode/sourceSha, stored remote runId. Release/tag: peeled SHA, version, draft flag. Assets: remote ID/name/size/content digest. Web: target/project/branch + runId + manifest SHA + output digest. Database: exact pending set and history/content evidence/postconditions. Function: source digest, remote version, readiness.
Unknown response always inspect first. Never select latest run or overwrite conflicting asset. Proven absence permits only allowed bounded retry.

Transient retry maximum five attempts/15min with backoff/jitter/server timing. Remote active wait independent; initial Windows total180min (current jobs30+120 plus queue allowance), frozen configurable. Live propagation15min. Expiration reconciles, never redispatches automatically.

## Process and secrets

macOS user service, explicit absolute paths, no terminal inheritance; explicit resume after reboot. PID+creation/boot ownership; own interruptible tree TERM then bounded KILL. Noninterruptible effects finish/reconcile boundary. No suspension. Sleep resets resource stability; CI wall deadline continues while Mac sleeps.

Redact chunk-safe streams before writing. Multiline PEM and split tokens masked; unsafe raw output dropped. Secret bindings refreshed on resume, derived public key identity rechecked. No raw secret hashes in fingerprints.

## Backend and cleanup

Exact pending migration set must equal tracked intent; compatibility/beta checks before first dependent gate. No intent SQL or shell expressions. Unknown partial migration blocks. beta-down is not used on preexisting listeners; owned container/process identity required. Own generated env changes restored only if still matching runner-written content.
Target lock local to maintainer host; CI concurrency guards publishing; external human changes detected by fresh facts, not assumed prevented.

## Migration evidence and unavailable content identity

Never assume the service's migration history contains the exact source-file digest. For a migration this runner executes, persist a flushed prepared receipt BEFORE write: target project, migration version, exact tracked file SHA-256, source SHA, baseline history snapshot, transaction classification and vetted pre/post check IDs. On success, persist service history observation and successful postconditions as the observed receipt. Receipts live in durable run evidence, not analytics or a new production table.

After a lost response, an existing prepared receipt can be completed only if the same target/version is present, known preconditions/baseline have not drifted, and all postconditions pass. A history row alone is insufficient. Missing history plus independently proven no effects permits retry only for a transactionally safe migration. Partial/nontransactional/contradictory observations block with MIGRATION_EFFECT_AMBIGUOUS.

For an already-applied migration from before runner adoption, accept either a validated prior receipt or a separately established baseline mapping target/history versions to exact tracked source digests and verification results. Do not fabricate that mapping from filenames. If neither exists, return MIGRATION_PROVENANCE_UNKNOWN; explicitly report that history proves version presence but not source bytes. Baseline establishment is separate setup work, performed once with authoritative deployment evidence; lack of evidence is not permission to rerun an existing version.

No universal SQL introspection is introduced: checks are vetted source-controlled adapter functions. These observations establish operational reconciliation, not mathematical proof against concurrent privileged database changes.
