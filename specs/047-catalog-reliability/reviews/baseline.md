# 047 implementation baseline

Implementation is isolated in `/Users/daynero/RiderProjects/AffSupport-047-beta`, branch
`beta`, based on `e3fcc1941e19c092ed2daa7571bd3c35adc883d1` (1.3.3 build 79).
The checkout was created clean from the existing beta ref before the feature edits.
The original `AffSupport` checkout and production channel are not deployment targets.
The current diff contains the feature's known web/native/shared/Edge/analytics changes;
no production version, signed manifest, release tag, provider upload or remote migration
was changed. `baseline.json` records the current candidate paths without credentials.

## Evidence and limits

- Source contracts are read from shared/release.ts; live installed-agent support is not
  inferred from the source declaration. New executor capability acceptance is still open.
- Existing incident audit was captured against c31c3250/e3fcc194. F01–F12 map to the
  catalog manager, shared material actions, transfer handlers and analytics described in
  POST_RELEASE_PROBLEMS.md. New regression tests reproduce malformed command/list
  responses, partial trash refresh, native-only terminal loss, image cache integrity,
  cancellation and refusal reuse; further scenarios remain open in tasks.md.
- Beta profile exists locally. The owned candidate Functions environment and packaged
  beta proof are absent. Doctor observed occupied local Supabase ports owned by the
  existing beta integration checkout. No existing stack, app-support directory or
  pairing state was reset or stopped.
- The initial implementation increment passed the full fast verify (8678 tests, 60
  explicit skips). Its retained report is verification-fast-initial.json. Later scoped
  reports are separate and do not upgrade that result to a fresh full-candidate proof.
- Production investigation remains SELECT-only through the documented analytics CLI.
  Historical settings not captured by a producer remain unknown; source defaults do
  not reconstruct those choices.

This baseline records isolation/provenance and known gaps. It does not attest live
beta acceptance, provider correctness or completion of implementation tasks.
