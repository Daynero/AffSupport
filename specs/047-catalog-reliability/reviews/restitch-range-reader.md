# Protected restitch range implementation in progress

Based on checkpoint `7593d630`. These are working changes, not complete feature
or manual acceptance. The new path remains internal and cannot initialize a root
or be reached through a generic download/upload grant.

Causal failures and corrections:

- Settlement readback compared JSON field insertion order. Expected reservation
  measurements are now normalized by the strict kernel parser; unexpected RPC
  measurement fields still fail SQL validation.
- Stale calls inferred a newer acquisition. Reserve, refresh and reacquire now
  require the originating acquisition and check it against the CAS state.
- An untracked Response was left open, clock rollback between active waits was
  missed, and a metered OAuth/control response could be treated as an image.
  Cleanup adopts untracked bodies only for cancellation; the reservation stays
  held. Monotonic clock checks span waits. Separate image transport binds the
  frozen file ID, GET, exact Range and one media dispatch per reservation.
- Cancellation inside fetch could occur before the abort listener was installed.
  The listener now checks the already-aborted signal too. A nonquiescent fetch
  remains held after bounded cleanup rather than waiting the full I/O allowance.

The protected reader records image prefixes and active provider fetch/body waits,
including OAuth/metadata. DB/credential loading, CPU work, consumer delay and
bookkeeping latency are excluded. No bytes reach the response until measurement
settlement is acknowledged or exactly confirmed read-only. Overruns, lost permits,
unknown measurements and hung body cancellation never become fresh work.

The existing token and Drive clients are reused. They check frozen checksum,
size, MIME, accepted parent, current download access and live root ancestry before
requesting image bytes. Metadata-only versions do not reset the candidate. This
is not native decode validation or proof that a video reached a user.

Migration156000 adds private frozen provider mapping and an exact-acquisition
service reader. The existing reservation CAS repeats mapping/root validation to
close changes after context read. The service adapter resolves context and reads
credentials before reservation, then injects mandatory measured transports into
both clients. Its request scope is captured before awaits. Browser/native input
contains opaque identities and cannot choose provider targets or submit counters.

Focused verification passes 115 tests across seven files, including actual SQL
roles, the real token/Drive client adapters with synthetic network responses,
bookkeeping lost acknowledgement and strict missing/substituted authority. The
first expanded code-map check rejected a slash in diagnostic prose; corrected
wording passes the existing privacy fence. This is not real Google API acceptance.

The complete disposable native gate passes 439 migrations, 58 pgTAP files with 1284
assertions, 2 real Auth tests and 59 concurrency/recovery tests in 10 files. All
439 migration, 69 native-input and 4 kernel/executor hashes match their frozen
inputs. See verification-db-restitch-range-context.json. This gate proves the
schema/SQL boundary; the protected reader is checked by the separate focused and
pending full-source suite.

Only local beta migrated 438→439. The owned Edge service was quiesced for the
controlled preservation window; all 17 full-row snapshots matched, including empty
private selection storage. Edge was restored. The canonical generated public type
adds only the new service RPC, using pinned CLI 2.117.0 and the existing isolated
Docker network. The subsequent authenticated REST smoke refused all 4 internal
RPCs with 403/42501 and left private selection storage empty. A fresh manual UI
attempt remains blocked by unavailable Computer Use hosts; see the retained
manual-access evidence. All 13 canonical static gates pass with the 14 changed source/test/SQL hashes unchanged; see verification-static-restitch-range.json. The complete fast suite is still pending before any commit.

Remaining T016–T020 work includes accepted immutable recipes/pools, stable opaque
candidate versions across roots, actor-bound refusal integration, logical updater
and Launch aliases, dedicated grant/protocol negotiation, native/product wiring,
root retirement/unknown-range retention, diagnostics and real beta acceptance.
