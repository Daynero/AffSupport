# Release contract verification

> Current owner policy (2026-11-07): [intel-user-feedback-v1](release-policy.md). Physical/native Intel tests are post-release user feedback, not a publication prerequisite. Earlier hardware-blocking checkpoints below are historical; no unexecuted case is marked passed. ARM native beta, Windows hosted, static Intel seals/signatures and applicable Apple trust remain required.

New candidates require ARM Mac, Intel Mac and Windows; signed historical channels preserve their platform set. New channel set version 2 refuses missing Intel. Both Mac package seals include target, exact source, public beta config and web payload. Physical Intel observations require minimum and newer macOS, nonvirtualized native x64 and every required tool/auth/Finder/power/data case. Invalid substitutions fail closed. Windows evidence binds source/run and both smoke/final installer digests.

Manifest-only changes reuse sealed packages and require fresh exact-source proofs. Complete mini-release baseline binds both Mac proofs and Windows evidence to signed channel bytes. Published assets are read back and compared before adoption; absent assets may be uploaded without replacement only after exact tag-source readback. Unknown outcomes stop for reconciliation.

Regression commands/results are recorded in acceptance-matrix.md. No real workflow dispatch, upload, tag, signed channel modification or production activation was performed. Trust verification requires actual Developer ID/hardened runtime/Gatekeeper/stapled notarization on each Mac image. No fixture is a substitute for this external evidence.
