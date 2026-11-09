# Internal native control — working increment

This is not exposed by an Edge route, native route or installed capability.
Migration164000 passed the full447-migration disposable gate and is applied only
to local beta. All23 protected full-row table digests match across its quiesced
migration window. No control grant was created. All6 RPCs refuse an actual beta
owner JWT with403/42501. Public database types are regenerated from actual447.

The private control grant binds root/team/actor, real Auth session, native boot
and the original enrollment. Only service RPCs can access the row; RLS is forced,
and direct table access is unavailable even to service_role. Proof and control
token hashes are distinct and immutable. Challenges last2min and grants at most
24h. A root retains at most8 grants; replay keeps the original enrollment window.
No token or hash is returned by SQL.

The first native claim and its immutable control binding commit in one database
transaction under the original parent lock. A newly enrolled grant cannot adopt
an existing claim UUID, even when it supplies the same native instance. It cannot
close another grant's owner. New control authorization checks the current Auth
session, workspace rights, source identity, root state and exact executor epoch.
Logout and cancellation stop new authorization while retaining exact original
claim readback and historical closure bookkeeping. Neither expiry nor a missing
local journal permits takeover.

The internal dispatcher derives the actor/session from a trusted verified-Auth
dependency for enrollment. Enrollment ID is retained as the original grant ID
through unknown replies. Ordinary user JWTs and body transfer tickets cannot
control a claim. Credential-bearing actions refuse every browser Origin before
SQL; only an origin-free original native proof can receive a purpose-bound MAC
control ticket. The claim path performs one exact read after an unknown reply,
never another claim mutation. The host still must provide CORS, bounded intake
and the actual verified JWT-session extractor; no host route is wired yet.

Controlled verification:203 tests across7 files pass in
`native-control-internal-second-focused.log`, including72 PGlite storage tests,
14 handler tests,27 generic executor-adapter tests,34 native executor/journal
tests,44 downloader tests and12 finance UI tests. Counts describe this one run;
do not add them to overlapping earlier runs. The initial203-test run passed202
and failed one newly written cancellation fixture because it bypassed the
terminal timestamp constraint. The corrected fixture invokes the real public
cancel RPC and the database constraint remains unchanged.

Native acceptance passes all60 pgTAP files/1320 assertions, including20 new
control assertions, and all71 native tests/10 files, including2 new actual races.
The foreign-grant race deliberately uses the same native boot, so existing boot
mismatch checks cannot mask an adoption defect. Three real isolated Auth tests
also pass: the new HTTP logout removes the original session and the same private
session guard rejects it afterwards. This replaces the earlier Auth2-only proof
for current acceptance; both records retain their original source hashes.

See verification-db-restitch-native-control.json and the actual beta migration/
refusal receipts. The first native run and the later real-logout run both pass.
Project/script/test checks passed in the12/13 static run; its only lint defect was
an unused initial value in the new native fixture. Targeted lint and full test
typechecks pass after correction, and again for the new Auth fixture. This does
not relabel that earlier canonical run as13/13. Full current-source verification
and installed/product/manual acceptance remain open.

The previous V6 full check passed all13 static gates and2353 tests in2/8 shards
but failed a finance test that took a mock-call snapshot before the separate
visible-application effect. Its unchanged original focused12-test run passes;
the test now awaits the actual applied signal with the existing timeout before
snapshotting. The203-test run covers this correction; full suite remains open.

## Remaining trust and diagnostic boundaries

- Persist enrolled credentials in environment-scoped platform secret storage
  before claiming; expose only safe metadata to browser/native public status.
- Bind range issuance and consumption atomically to this control grant and
  recheck its current session before provider dispatch. The older internal range
  RPCs do not yet enforce a control-grant/session binding. An authorize call
  followed by an unrelated range issue is insufficient; do not expose that gap.
- Source/control purposes, real installed controller wiring, old-boot recovery,
  updater/Launch aliases, conservative retirement and all product paths remain
  open. A claimed owner flag is not permission for new I/O or media processing.
- Define and verify enrollment/claim/owned/draining/closure/recovery stages with
  original correlated root/enrollment/grant/claim/epoch identities. Terminal and
  user-delivery proof stay separate. Diagnostics must exclude tokens, hashes,
  Auth session IDs, provider data, content and paths. Existing producer-to-CLI
  coverage is not proof of coverage for this newly internal component.
- No packaged/installed beta, manual walkthrough or production result is claimed.
