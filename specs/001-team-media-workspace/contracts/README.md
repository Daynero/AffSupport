# Contracts: Командний медіапростір Soty

Behavioral contracts for four surfaces:

1. Caller-checked Supabase `security definer` RPCs + defense-in-depth RLS — relational reads
   and atomic domain changes.
2. Supabase Edge Functions — Google OAuth/Drive, invitation delivery, transfer grants, and
   bounded sync work.
3. Google resumable upload + Soty Range gateway — file bytes without exposing Google
   credentials or buffering whole files in Edge.
4. Local Fastify agent bridge — existing tools, archive inspection, isolated landing
   preview, large download, and processing.

Concrete validators and discriminated payload types live in `@video-compressor/shared` and
are exported from the package root. These documents define behavior, not duplicate type
bodies.

## Requirement traceability

| Area                      | Requirements                                                           | Primary design proof                                                                                                                    | Validation           |
| ------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Teams and invitations     | FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008         | [teams-and-members.md](./teams-and-members.md), membership/invitation entities and owner invariant in [data-model.md](../data-model.md) | Quickstart V2–V3     |
| Roles and authorization   | FR-009, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016, FR-017 | [teams-and-members.md](./teams-and-members.md), [db-functions.md](./db-functions.md), RLS/effective-permission model                    | Quickstart V3 and V9 |
| Shared Drive connection   | FR-018, FR-019, FR-020, FR-021, FR-021a, FR-022, FR-023, FR-024        | [drive-storage.md](./drive-storage.md), credential/connection/catalog entities and live ancestry/capability guard                       | Quickstart V4–V5     |
| File operations and audit | FR-025, FR-026, FR-027, FR-028, FR-029, FR-030, FR-031                 | [drive-storage.md](./drive-storage.md), [preview-and-processing.md](./preview-and-processing.md), operations/audit entities             | Quickstart V7–V9     |
| Catalog and search        | FR-032, FR-033, FR-034, FR-035, FR-036, FR-037                         | [catalog-and-search.md](./catalog-and-search.md), material metadata/search model                                                        | Quickstart V5        |
| Preview and processing    | FR-038, FR-039, FR-040, FR-041, FR-042, FR-043, FR-044                 | [preview-and-processing.md](./preview-and-processing.md), transfer/provenance contracts                                                 | Quickstart V6 and V8 |

## Authentication modes

- **User RPC/Edge**: Supabase user JWT. Edge first uses a user-scoped client/RLS guard;
  service-only credential access begins only after success.
- **Local agent**: existing origin + `x-session-token` + entitlement checks, plus a scoped
  team transfer grant for any cloud material.
- **OAuth callback**: no Supabase JWT; one-time state + PKCE transaction, TTL, atomic consume.
- **Catalog worker**: named server secret only; never a publishable key or user JWT.

Every feature SQL function in all four modes is `security definer`, has
`set search_path=''`, schema-qualifies every object, and receives an explicit narrow EXECUTE
grant. A caller-facing read/action derives identity from `auth.uid()` and applies its own
active-profile, membership, permission, and team predicates; it does not rely on owner
execution or RLS to filter sensitive output.

CORS is enforced on browser endpoints but is not an authorization boundary. Callback and
cron endpoints have explicit exceptions to browser-origin handling.

## Response and error conventions

- Success is a typed entity snapshot or `{ ok: true, ... }`; accepted asynchronous work is
  `202 { operationId, state }`.
- Edge JSON failure is `{ ok:false, error:{ code:MACHINE_CODE, retryable:boolean,
details?:SafeDetails } }`; the local agent retains its constitutional
  `{ error:MACHINE_CODE }` envelope. Neither includes a human sentence, provider body,
  token, file name, path, query, transcript, or stack trace.
- Common codes: `AUTH_REQUIRED` (401), `PERMISSION_DENIED`/`NOT_A_MEMBER` (403),
  `NOT_FOUND` (404), `INVALID_INPUT` (400), `WRONG_STATE`/`NAME_CONFLICT`/
  `ALREADY_MEMBER`/`EXPIRED` (409), `TOO_LARGE` (413), `UNSUPPORTED_MEDIA` (415),
  `CORRUPT_OR_PROTECTED` (422), `RATE_LIMITED` (429), `DRIVE_UNAVAILABLE`/
  `NEEDS_REAUTH`/`DELIVERY_UNAVAILABLE`/`OAUTH_APPROVAL_REQUIRED` (503), and
  `ROOT_ESCAPE` (403).
- Provider errors are mapped to this closed union. `invalid_grant` maps to `NEEDS_REAUTH`;
  Google 429/5xx retain retry metadata without leaking raw responses.
- OAuth callback success/failure uses a 303 redirect to the Soty web origin with an opaque
  result code; it never renders provider content.

## Boundary rules

- Every untrusted body/response begins as `unknown` and is narrowed; no unchecked cast.
- All Drive mutations carry an idempotency key and are implemented as operation sagas.
- Google access/refresh tokens never leave Edge/Vault. A resumable session URI or transfer
  token is a scoped bearer capability: short-lived/current-operation-only, redacted from
  logs, never stored in browser persistence, analytics, audit target, or error details.
- Cached Drive parents/capabilities are display data. Live ancestry + per-item capability is
  checked immediately before every external side effect.
- Cloud operation/catalog changes use RLS-filtered Supabase Postgres Changes and refetch the
  authoritative row after reconnect/event. Local tool progress uses the agent's SSE path.
  Neither transport polls.
- `DRIVE_OAUTH_MODE` is parsed from a closed `disabled|testing|verified` union and defaults
  to disabled. A production signal from the canonical site URL, request, or OAuth transaction
  always requires verified mode before any transaction/provider/Vault/connection side effect.
- The same shared classifier and transcript limits are used by sync and every finalize path.
  Transcript content never enters Realtime, analytics, audit, logs, or error payloads.

See the individual contracts for request fields, guards, effects, and failure recovery.
