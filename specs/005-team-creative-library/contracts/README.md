# Contracts: Team Space / Creative Library

These contracts extend feature 001 rather than replacing its membership, RLS, Drive,
catalog, transfer, preview, audit, error or agent contracts.

## Surfaces

1. Caller-checked PostgreSQL RPCs own tasks, attachment references, scans, claims,
   preferences and closed reads.
2. `library-ops`/`drive-ops` Edge routes own structural Drive writes, resumable batch
   orchestration, grouped sidecar lifecycle, job grants and permission-on-demand sharing.
3. The existing local `team-bridge` owns bounded language/thumbnail/processing work and
   never receives Google credentials.
4. React consumes only typed wrappers and uses Realtime/SSE as invalidation/progress signals,
   never as authorization.

## Requirement traceability

| Area                         | Requirements                        | Contract                                                       | Validation       |
| ---------------------------- | ----------------------------------- | -------------------------------------------------------------- | ---------------- |
| Bulk + placement             | FR-001–FR-033                       | [library-and-bulk.md](./library-and-bulk.md)                   | Quickstart V1–V3 |
| Shared processing + sidecars | FR-034–FR-056, FR-042a–c, FR-043a–c | [processing-and-sidecars.md](./processing-and-sidecars.md)     | V4–V6            |
| Task space + attachments     | FR-057–FR-068, FR-057a–h            | [tasks.md](./tasks.md)                                         | V7               |
| Share + contributions        | FR-069–FR-088                       | [sharing-and-contributions.md](./sharing-and-contributions.md) | V8–V9            |

## Common boundary rules

- Every untrusted request/provider/agent/drag payload begins as `unknown` and is narrowed by
  `@video-compressor/shared`.
- User endpoints require an active Supabase identity and exact team permission before any
  service-role/provider call. Service and lease tokens are hashed/scoped/expiring.
- Success uses a discriminated result or accepted operation snapshot. Failure uses the
  existing `{ ok:false,error:{code,retryable,details?} }` Edge envelope or agent
  `{ error:CODE }`; no provider/human sentence is an error code.
- All Drive mutations are idempotent, prove live ancestry/capability, verify the provider
  result, then commit catalog state. Partial group work is `reconciling`, never success.
- Transcript/content, filenames/paths, Drive URLs/ids, grants/session URIs, provider bodies
  and arbitrary metadata never enter logs, analytics, contribution rows or Realtime.
- No production deployment/release is authorized by these contracts.
