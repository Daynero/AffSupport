# Implementation evidence — 046

Baseline HEAD b0c0077b; pre-existing edits preserved (baseline.json).
Requirements checklist PASS; hooks absent. Ignore files cover build artifacts/secrets; no new ignore rules needed.
Known prior verify failure: JS route budget 46,086 > 40,000 bytes.
No production action authorized or performed.

## Work log

- T001: baseline, checklist and local prerequisites inspected; migration names free.

- Core regression: transcription-retirement (7), whisper-chunks (13), transcription-words (14): 34 passed; initial retirement test first reproduced 6 failures.
- T003: source splitting moved without changing the algorithm; source word/chunk regressions green.

## Verified implementation checkpoints

- Native PostgreSQL: `SOTY_TEST_DB_SOURCE_PROJECT=acceptance036 npm run test:db`: PASS, 41 pgTAP files / 970 assertions, real isolated Auth 2 tests, six native suites / 27 tests. Source stack unchanged; only schema/role definitions copied. A first run using the DB-only affsupport037 stack passed pgTAP but lacked an Auth source; rerun on the full local stack passed.
- Feature prefix upgrade harness: both deterministic finalizer/cutover orderings PASS; unfinished legacy states, late accept/heartbeat/fail/cancel, stored-intent grant with null tool, active+retired bulk retry (1 then0), material preservation. Local schema types generated with the canonical command against the owned clone; no source data or credentials copied. Current SQL source deployed nowhere.
- Full typecheck PASS before the last diagnostics/test additions; canonical verify repeats it.
- Source regression batches: initial34 PASS; expanded original pipeline237 PASS plus seven obsolete expectations corrected; another206 PASS plus remaining fixture expectations corrected. Latest corrected batch/suspension cases21 PASS. Final consolidated suite remains the acceptance gate.
- `agent-journal-ingest`32 PASS, including actual bounded API6 producer → DiagnosticsLog sanitizer → latest SQL ingestion → read-only CLI inspect for success/failure/cancel/interruption/missing terminal/retry; repeated ingestion deduplicates. Reader4 and registry9 PASS. Saved and user visibility remain distinct.
- Chromium component fixtures: uk/en × light/dark ×1280/390, no JavaScript page errors; speech settings/model gate and Hindi original-only modal. Source width1150/352px, no second column. Screenshots visually inspected. Tooltip fg/bg light rgb(33,26,44)/white; dark rgb(246,242,248)/rgb(43,35,56). Fixture uses actual token/CSS cascade and mocked local media API; it is not packaged beta or live delivery proof. The stock development React-refresh wrapper reported `Missing field moduleType`; fixture server omitted that development wrapper without changing application configuration.
- Packaging discovery: TypeScript leaves orphan JS after source deletion. Agent build now empties its repository-owned dist before compiling; old user models/cache are untouched.
- Coverage inventory removes only deleted executors and carries the unchanged95 floor to relocated original segmentation. Existing floors and ratchet remain enforced.

## Remaining acceptance boundaries

No production activation, product-version bump, stable-manifest edit, tag or provider-file deletion. Packaged exact-candidate beta and native Windows acceptance are not proven by component fixtures or local SQL. Real analytics delivery is not proven in telemetry-disabled beta. Canonical verification results are recorded below when finished.

## Final implementation review additions

- Native agent build PASS after shared build; repo-owned dist now contains no
  translation directory, coordinator, bilingual export or target-language re-export.
  A prior fast run passed13 static gates and1917 tests, then three restart tests
  exposed the stale pre-change dist. Rebuilt agent: all three restart tests PASS.
- Final focused UI/protocol/read batch:6 files /27 tests PASS, including four new
  library result delivery tests. Optional accepted-attempt UUID survives the text
  parser; visibility is emitted after text commit, copying after clipboard success;
  legacy companion provenance stays unknown. No content/source version/name enters
  these events. Existing preview/sidecar rendering and registry tests remain green.
- Grant adversarial harness now includes the stored-intent table required by the
  latest consume-grant function. Adversarial counter/tickets/retention:23 PASS.
- Final residual search:323 classified occurrences across7 semantic groups in
  residuals.md. Product locales/legal/home/tool descriptions have no retired labels.
  Three historical pivot measurements remain as evidence; current reliability tasks
  and acceptance no longer require the removed pass.

## Observable limits and fallback evidence

- Browser close, blocked telemetry, offline journal transport or retention/ring loss
  cannot prove user delivery. Missing terminal/visible remains unknown in the CLI;
  native saved and server registered are separate fallback facts.
- Historical original companions have no accepted-attempt provenance. They remain
  readable/copyable; no operation is invented. A current original result includes
  its accepted attempt, linking the result display/copy to batch receipts.
- The retired-state projection is a bounded current snapshot, not reconstructed
  point-in-time history. Missing schema/actor, truncation and changes after as-of
  remain explicit. Migration filename dates never imply producer applicability.
- Component fixtures verify current CSS/layout but do not prove native Windows,
  real speech quality on all models, exact-candidate packaging or production
  analytics delivery. Telemetry-disabled beta cannot supply the latter proof.

## Final build and upgrade evidence

- Shared build PASS; clean agent build PASS; web production build PASS.
  Generated app dist checked: no translation directory/coordinator/bilingual export
  and no removed target-language helper export. No user cache was traversed.
- Final upgrade harness PASS for finalize_first and retire_first, now including
  actual latest SQL text-variant read, translation-only absence, original companion
  fallback, accepted-attempt provenance and permission denial. Initial expanded
  fixture runs exposed missing category/source-version identity in the synthetic
  fixture; fixture corrected to the canonical schema checks, guards unchanged.
- Fresh-bundle performance check:6 PASS /1 FAIL. Existing Launch exclusive graph
  baseline46086B→46112B, ceiling40000B. This pre-existing unrelated route-budget
  failure is retained; no allowance/ratchet was increased. Source/package negative
  surface checks PASS.
- Read-only release contract check blocks: “stable release manifest does not
  identify the build being verified”. No stable manifest/version was edited to
  make a pre-release working tree look published.

- Read-only beta doctor: blocked by ports54321/54322/54324 already occupied.
  Existing local services were not stopped, reset or migrated. Native Windows is
  unavailable in this macOS session. Exact-candidate packaged acceptance T050
  remains unproven; no production readiness claim or activation follows.

- Final fast run:13 static gates PASS,3784 tests PASS; stopped in shard4 at the
  obsolete release fixture expecting transcription contract5 to be compatible.
  Fixed fixture now asserts5 refused/6 accepted. Focused release/native routes/
  library facade/code map:32 PASS. Agent rebuilt again after native route fix.
- Native team HTTP boundaries now return409 FEATURE_RETIRED before delegate work
  for retired tool/kind, stay behind authentication, and preserve upstream
  FEATURE_RETIRED instead of flattening it to PROCESS_FAILED. Added real Fastify
  route regression and direct facade refusal; code map includes these boundaries.
- Full release-form verification started on final source with the local disposable
  DB source override. Prior fast failure evidence is retained in verification-fast.json.

## Canonical release result and repair scope

- Release form:13 static gates PASS;5848 tests PASS,5 FAIL in six completed shards.
  The failures were the known Launch graph budget46112>40000, plus four retirement
  regressions: removed lifecycle in a registry expectation, obsolete sleep allowlist,
  new diagnostics module missing from the derived critical inventory, and an old
  exact not-found shape expectation that did not include the new explicit unknown
  diagnostic projections. Canonical failure retained in verification-release.json.
- All four retirement regressions repaired:85 focused tests PASS. Unknown/unsafe
  inspect IDs still require found:false, empty evidence and historical unknown;
  no invented matches. Diagnostics now has its own95 critical floor. No existing
  floor, budget or global ratchet was lowered.
- Unexecuted shards7/8 are being run separately with the canonical single-worker
  shard arguments. Their result is a focused continuation, not a green canonical
  release gate; remaining-shards.json records the actual outcomes.

## Follow-up completion

- Remaining shard7:1106 PASS,2 obsolete analytics expectations FAIL; shard8:904 PASS,
  no failures (9/5 native-prerequisite skips respectively). Both analytics fixtures
  repaired: lifecycle metadata remains privacy-safe and every unavailable projection
  is explicitly unknown. Final six-file regression/ingestion run:88 PASS.
- New diagnostics module measured100% line/statement coverage (63/63),92% branches,
  85.71% functions in the focused run; its critical line floor is95. This is a
  focused module measurement, not a complete global coverage/ratchet verdict.
- All eight unit shards were exercised across canonical and focused continuations.
  Every observed retirement regression has a passing affected-suite rerun. The
  unchanged canonical performance failure remains46112>40000; no full green
  verify/release or global coverage claim is made from combined subruns.
- Final residual inventory325 occurrences: original323 classifications plus the two
  native HTTP refusal literals explained in residuals.md. No active executable or
  product-visible translator residue found. After-implement hooks absent.
- T038 manual matrix and T050 exact-candidate native packaging remain incomplete.
  Only reversible repository changes and owned local fixtures were performed.

## Final local acceptance status

- Final scoped static verification PASS:13/13 gates; exact result retained in
  verification-static.json. This scoped success does not replace the failed
  full release/suite evidence.
- Extended Chromium page matrix PASS:56 cases (normal, empty, checking/loading,
  failed job, disconnected, first-run speech install, model download) ×uk/en ×
  light/dark ×1280/390. No JavaScript errors or retired network calls/product labels.
  Desktop focus smoke and mobile settings-expand/help tap/Escape smoke passed.
  Uses actual TranscriptionPage/components/CSS with fixture AgentContext/API,
  disabled analytics and an omitted unrelated App/onboarding shell. It does not
  prove packaged authentication, complete host-shell layout or live delivery.
  Representative desktop/mobile screenshots inspected. Earlier Hindi modal/tooltip
  matrix verifies original-only rendering and tooltip colours separately.
- T038 component/browser checks complete; native install/use/upgrade/package matrix
  remains T050. Exact candidate is not sealed: baseline/pre-existing working-tree
  changes remain preserved. Beta doctor ports54321/54322/54324 occupied; native
  Windows unavailable. Full coordinated DB/Edge/shared/agent/web release required
  for API6, never a web-only mini activation. Production unchanged.
