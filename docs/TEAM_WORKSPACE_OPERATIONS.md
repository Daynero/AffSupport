# Team media workspace operations

This runbook covers the team workspace without deploying or mutating production. Treat a
connected Google Drive as customer storage: database recovery must never imply deleting,
moving, restoring, or replacing provider files.

## OAuth deployment gate

`DRIVE_OAUTH_MODE` is server-only, closed, and fail-closed:

| Mode                         | Local/isolated development                            | Canonical production origin                         |
| ---------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| missing, unknown, `disabled` | Refuse before transaction/provider/Vault side effects | Refuse before side effects                          |
| `testing`                    | Allowed only when every production signal is absent   | Refuse with `OAUTH_APPROVAL_REQUIRED`               |
| `verified`                   | Allowed                                               | Allowed after the normal identity/permission checks |

The canonical production signal is `PRODUCTION_SITE_ORIGIN` from
`packages/shared/src/release.ts`. `WISHLY_SITE_URL`, the request origin, and the persisted
OAuth transaction origin are checked independently; any one matching production requires
`verified`. Changing the mode after OAuth start does not bypass the callback check.

Production remains `disabled` until the restricted Google Drive scope has completed the
required verification/security assessment. Record the approval owner, project/client id,
scope list, approval date, and next review date outside this repository. Review the restricted
scope approval at least annually and before changing domains, OAuth client, privacy policy,
data use, or scope. If approval lapses, set the deployment to `disabled`; never fall back to
`testing` on the production origin.

Google OAuth apps in Testing can issue time-limited refresh access. Treat `invalid_grant`,
revocation, expiry, and account-policy failures as `needs_reauth`; do not delete the catalog,
metadata, provenance, audit history, or existing Vault secret until replacement succeeds.

## Secrets and providers

Use the names in `supabase/functions/.env.example`:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`: Edge only.
- `RESEND_API_KEY`, `INVITE_EMAIL_FROM`: use a verified Resend sending domain. Invitation
  persistence is authoritative; provider failure leaves a visible retryable delivery state.
- `CATALOG_SYNC_SECRET`: named worker authentication only.
- `WISHLY_SITE_URL`, `PRODUCTION_SITE_ORIGIN`, `DRIVE_OAUTH_MODE`: deployment gates, never
  credentials.

Before packaging, releasing, or deploying a production build that advertises Team Workspace,
run `npm run verify:team-production`. The gate inspects only Supabase secret names and the
deployed non-secret readiness result; it never reads or prints credential values. It requires
Google OAuth, Resend invitation delivery, and the catalog worker to be configured, and it
requires the live production OAuth mode to report `verified`.

Local values belong in the ignored `supabase/functions/.env.local`; hosted values belong in
the verified isolated project secret store. Never place Google access/refresh tokens,
resumable session URIs, transfer tickets, Vault ids, or provider response bodies in browser
storage, logs, errors, audit targets, Realtime payloads, analytics, fixtures, or support
messages. Refresh tokens live only in Supabase Vault and are read through the narrow
service-only accessor.

## Root and reauthorization recovery

1. Confirm the caller is still owner and the team is active.
2. Revalidate the root by immutable folder id and live ancestry/capabilities. A rename or
   in-root move does not require reconnecting.
3. For `needs_reauth`, run the one-time OAuth flow and replace the credential atomically only
   after the new token and root proof succeed. Preserve catalog rows and provenance.
4. For an unavailable/trashed root, restore provider access or explicitly select and confirm
   a replacement root. Queue reconciliation; do not manufacture catalog success.
5. Detach only after explicit confirmation. Revoke outstanding transfer grants and stop new
   work; retain metadata, tombstones, provenance, and audit history.

My Drive uses no `driveId`. Shared Drive must carry its `driveId` and use the all-drives flags
for list/get/change/create/update calls. Cached parents and capabilities are display hints;
every write proves live source and destination ancestry and the relevant per-item capability.
Wishly role removal does not revoke independent sharing configured directly in Google Drive;
show that warning during membership/root changes.

## Published limits

| Surface               | Limit/behavior                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Team members          | 50 active members; invitation validity 14 days                                                       |
| Catalog target        | 50,000 visible materials per team                                                                    |
| Transcript ingest     | bounded to 1 MiB at a valid UTF-8 boundary; explicit full/truncated/invalid/unavailable state        |
| Embedded editor       | complete valid UTF-8 `.txt` only, at most 1 MiB; `.srt`/`.vtt` remain read-only previews             |
| Transfer range        | at most 32 MiB per permission-rechecked request                                                      |
| Browser full download | at most 100 MiB; larger files hand off to the compatible local agent                                 |
| Agent intake          | at most 100 GiB, with the selected tool's lower limit still authoritative                            |
| Resumable upload      | 256 KiB alignment; session URI remains memory-only                                                   |
| Archive preview       | manifest only; at most 5 GiB total uncompressed and 2 GiB per entry, plus scanner ratio/count limits |
| Transfer grant        | short-lived, purpose/team/actor/material/operation scoped, bounded uses, hashed at rest              |

Only complete valid TXT content can be edited. Transcript/search text must never enter
Realtime, analytics, audit, logs, error details, or provider diagnostics. SRT/VTT preview is
sanitized cue text, never HTML. A source identity change returns `SOURCE_CHANGED`; the user
must reload or create a distinct version. Exact replacement is a separate confirmed action
requiring both upload and edit permission. Trash is recoverable only within current Drive
retention/admin policy; direct provider purge cannot be guaranteed recoverable by Wishly.

## Safe failure and reconciliation

- Every Drive mutation is an idempotent saga: authorize, reserve, perform, verify, commit the
  catalog/audit result, then report success.
- A provider success followed by database failure stays non-terminal until reconciliation
  verifies the exact provider result. Retry with the same idempotency key; never start an
  implicit replacement.
- Permission loss, root escape, stale source, grant expiry/use exhaustion, agent mismatch,
  provider outage, and cancellation are typed outcomes. Do not log provider bodies.
- On shutdown/update drain, refuse new team tasks, cancel bounded local work, and clean only
  temporary agent directories. Never kill another active Wishly Dev process.

Use `specs/001-team-media-workspace/quickstart.md` for the isolated V1–V9 validation matrix
and `supabase/migrations/ROLLBACK.md` for reverse-order development recovery. Neither document
authorizes a production migration, deploy, release, or destructive rollback.
