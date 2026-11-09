# Protected native screen transport — working increment

The controller-next checkout adds a dedicated native downloader. It is not wired
into a public route, capability, production fallback or installed beta agent.

The downloader captures the exact protected cache binding before awaiting authority.
An injected authority must persist the original request/grant IDs before issuing;
the downloader cannot manufacture those receipts or reset a durable budget. Each
permit must bind the same root, actor/team, namespace, owner epoch/native instance,
slot, frozen image version and acquisition. Range size is at most2MiB. A permit
names a dedicated screen purpose and opaque ticket; it is never a generic
TeamTransferGrant. Local time is not authority for ticket expiry.

Requests use only the configured HTTPS or loopback endpoint, refuse redirects and
carry the ticket in a header. The server reader now returns the original reserved
request ID after settlement. Native checks that ID, status, exact range, size and
MIME, then hashes actual bytes written, including complete short filesystem writes.
It returns a file only after exact size/MD5 validation. The cache must still perform
its own authority check and full bounded decode.

There is no automatic HTTP retry, ticket reuse, refresh, new draw or reacquisition.
An error retains only the original opaque request ID; provider bodies, tickets,
URLs, checksums and local paths do not enter its public error. Authority uncertainty
stays explicit. General network/access/disk failures are not proof of a defective
image. The outer controller must reconcile the original reservation and, when
needed, explicitly acquire the same frozen candidate under the remaining durable
budget. A lost completed response cannot be retried at offset0 in the same
acquisition.

The original reader/cancel promise is awaited before cleanup and completion.
Failed cancellation stays accounting-uncertain. Local handles close before removal
for Windows. Pre-cancellation creates neither workspace nor authority.

The combined native-delivery focused run passed 274 tests in 10 files, including
multi-range delivery, malformed/substituted permits, wrong response identity,
short/oversized/corrupt bytes, non-retry and deferred/failed cancellation. This is
controlled component evidence. Full current-source verification and installed
beta product acceptance remain open.

Durable native authority adapter, source/control purposes, observed executor
quiescence, retention and complete producer-to-CLI/product acceptance remain open.

The related recovery coordinator had three reproduced mutable-reference defects:
a provider could change the selected checksum in place, change the returned path
while acceptance was awaited, or append another slot through the caller's array.
A bounded actual-source probe fails all three assertions before the fix and passes
all three after it. Candidate identity now comes from the shared parser's copied
screen and is frozen before provider calls; result primitives and requested slots
are captured. The corresponding three Vitest regressions await the next focused
run. This source probe does not replace the full suite or installed beta acceptance.

Seven bounded actual-source downloader probes now pass: multi-range assembly,
changed/short/oversized payloads, substituted request/scope and unknown issue ACK.
These probes use controlled transport and do not prove an installed route or
actual provider delivery. Another causal probe reproduced four lost closed cache
reasons (accounting uncertainty, disk full, cancellation and invalid response);
after correction all four survive the cache unchanged, without refusal memory.
Corresponding Vitest cases and a real reader-to-native-to-cache component test
are written but have not yet run. Full tests remain the acceptance gate.

## Original reservation correlation

Two causal regressions first failed: a lost reservation reply discarded the
original request ID both at offset zero and after an already completed range.
The downloader now retains a UUID from its typed authority error, normalizes it,
and drops malformed identifiers. It never substitutes an earlier range's ID or
issues another reservation. The subsequent combined run passes 74 tests across
the downloader, native executor and filesystem journal. This is not an installed
controller or a complete producer-to-CLI acceptance result.

## Native ownership and process interruption

The internal native executor and metadata journal own original activity promises
before callbacks run, serialize metadata writes, join activity and cleanup before
requesting exact remote closure, and retain unknown claims instead of admitting a
new epoch. Explicit cancellation and a global failure are separate: a global
failure aborts sibling activity and preserves the original cause; a canceled claim
with a lost reply remains accounting-uncertain. The journal bounds reads/writes,
validates captured metadata and replaces a synced staged file atomically. It makes
no directory-fsync or power-loss guarantee. Missing/corrupt metadata never proves
that an old remote owner stopped.

The 30 executor/journal tests pass, including real filesystem restart, rejected
unawaited activity, actor changes and uncertainty retention. Project and test
type checks and targeted lint passed before the additional downloader correlation
change. Private enrolled native control, product wiring, complete diagnostic
coverage and manual acceptance remain open; no capability is advertised.

Four additional recovery tests pass (34 executor/journal tests total): only this
process's already joined activity may reconcile a lost close with the original
persisted nonce. Duplicate requests share completion; shutdown joins that original
reconciliation. Unknown claims, restored journals and stale actors cannot use it
to declare closure. It neither creates another claim nor redelivers a callback
result. The existing service closure primitive is idempotent on this exact nonce.
