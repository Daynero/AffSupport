# Native source integrity — working increment

This increment exists only in the manager-next candidate after the preceding
root/epoch package passed full verification and was committed as702e151a. It is not yet applied to the running
beta and does not enable a native restitch selection capability.

A direct probe against the real TeamTransferClient reproduced acceptance of
same-size corrupt bytes with unchanged version and MD5 headers. The downloader
previously compared identity headers across ranges without hashing the bytes.
A second probe reproduced mutation of the caller's grant after validation but
before the filesystem awaits completed.

The downloader captures its original request and grant before awaits. It checks
advertised binary MD5 syntax and hashes actual successfully written chunks. A
range updates the committed digest only after its declared length is received;
interrupted prefixes are truncated and never counted twice on retry. Partial
filesystem writes are completed before a chunk enters the digest. A final size
check and byte digest run before returning a source to any processing delegate.
Mismatch fails with the existing SOURCE_CHANGED; malformed checksum uses existing
INVALID_RESPONSE. Failed work closes the source handle before removing the
workspace, including on Windows. Legacy inputs without a checksum remain
unverified; this change does not invent a trusted checksum for them.

The real lightweight boundary probes pass same-size corruption refusal and
cleanup, retry after a partial stream, uppercase MD5, actual one-byte filesystem
writes, and original-grant capture. The follow-up regression run passes143 tests in6 files, including
source retry, immutable request, real processing refusal, actual journal
sanitizer/SQL ingestion/SELECT-only inspect and historical-refusal boundaries.
Complete type/lint checks, full-source verification and installed beta-agent
acceptance remain pending for this increment; no full verification is claimed from these probes. The real
processing bridge also stops before its delegate and emits the sanitized
checksum_mismatch terminal in a lightweight source probe.

The process terminal carries a closed safe sourceIntegrityReason. No checksum,
source bytes, provider payload, path or grant is recorded. Read-only inspect adds
the nullable reason and preserves missing or unrecognized details as a blind
spot. A producer → sanitizer → actual SQL ingestion → SELECT-only inspect case
asserts that corrupt source bytes never reach the tool or upload. This case passes in the143-test combined run. The capability inventory describes the intended seam;
acceptance is still pending.

This is partial T016/T020 preparation. It does not bind a source to a new frozen
root, issue range/control authority, prove native quiescence, or implement the
still-open fallback controller and full manager acceptance.

Candidate-provider acceptance now passes against real local beta: one fresh
agent-purpose download grant delivers the exact44-byte synthetic CSV and another
fresh grant tests controlled local transit corruption with the same headers. The
candidate refuses the changed byte with SOURCE_CHANGED/checksum_mismatch on its
single read, and both workspaces are cleaned. Provider content is unchanged. See
native-source-integrity-beta-provider.json. This executes the candidate source
module, not an installed beta agent, full source suite or manual UI walkthrough.
