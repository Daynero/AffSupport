# Protected screen cache — working increment

The new internal resolveProtected seam requires a current exact service
acknowledgement of the original root/team/actor, database pool namespace, executor
epoch/native boot, slot, immutable version/acquisition and image metadata before
any cache lookup or decode. It captures only the whitelist of primitive fields
and the original loader methods before awaiting that acknowledgement. Revocation,
missing/substituted receipts and cancellation cannot fall back to a warm file.

The dedicated loader supplies a local source through its own protected range
transport contract. It is never cast into a generic download/process grant.
Storage reuses the existing MD5, full managed decode, cancellation and cleanup
path; protected reads additionally require the exact accepted size. Warm reuse
still validates actual cached bytes. It is snapshot/cache evidence, not a fresh
provider observation, video output or user delivery.

Protected refusal memory uses the stable version UUID within its actor-bound DB
namespace and slot. Legacy checksum-only exports do not borrow these records.
Corrected size/MIME metadata can therefore become a new eligible version even
when the original image bytes have the same MD5. Local persistence remains bounded
by the existing TTL/per-scope policy. Rejection diagnostics add only root/slot and
opaque version identity with the closed reason, never checksum, file name, path,
provider payload or ticket.

A real concurrent fixed-clock regression reproduced both cache writes failing
because their staging names shared process ID and millisecond. Staging names now
use random UUIDs. The original failure is retained in protected-cache-first.log;
58 protected and legacy tests pass in protected-cache-version-memory.log.
Subsequent small guard/assertion changes still need the combined source checks.

No public route or capability is enabled. Native control/source transport,
controller wiring, complete diagnostic ingestion/SELECT-only diagnosis, installed
acceptance and manual beta remain open. This component does not complete T017 or
feature047.
