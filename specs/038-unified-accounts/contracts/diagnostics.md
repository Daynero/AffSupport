# Diagnostic coverage contract

Current `team.accounts_finance` is unsupported by producer. Register sub-capabilities below and keep the aggregate partial until all required proof exists. Reuse typed analytics buffering, server `analytics_properties_are_safe_v2` / ingestion and read-only CLI, never a separate dashboard/database.

| Capability | Stages | Proven terminal / delivery |
| --- | --- | --- |
| accounts.overview | requested → accounts/finance/launch parts ready | complete or partial; rendered with source coverage |
| accounts.reorder | held → captured → drop → requested → accepted | canonical order confirmed → applied, or canceled/noop/conflict/denied/unknown |
| accounts.lifecycle | draft_resolution → preflight → requested → accepted | canonical lifecycle confirmed → hidden_no_period_data/retained_period_data/restored/parent_archived, or conflict/failed/unknown |
| accounts.decoration | intention → requested → accepted | persisted enum version → applied; failed/conflict/unknown |
| accounts.finance_edit | edited → validated → requested → accepted | confirmed field version → applied; partial multi-cell result or conflict/failed/unknown |
| accounts.topup_copy | resolve_drafts → complete_report → clipboard_requested | clipboard_confirmed or denied/unknown; external delivery unobservable |
| accounts.retained_actions | existing create/rename/delete/run/label/marker/2FA/clear/undo/history/legacy/export action → request | confirmed result and shown result; failure/cancel/unknown; no secret/content payload |

Use operation/attempt/flow UUIDs generated for diagnostics, not entity/external account IDs. Prefer receipt operation ID to correlate write acceptance; payload never includes raw financial request or ordered entity list. Allowed dimensions: closed action/entity kind, stage, outcome, failure code, source coverage, day relation (`today|previous|historical`), integer counts capped by shared rules, duration and build identity. No amounts, names, text, emails, colors chosen, 2FA, clipboard content, raw dates, provider data or pointer coordinates.

Bound collection: one stage transition per attempt, no frame/hover/scroll events. Repeated decoration intentions before a pending request settles collapse to latest queued intention and a bounded count. Local pre-request cancellations are aggregated per session/action with count cap; absence of an individual cancellation record is documented as sampling coverage, not an unexplained write failure. Delivery queue uses existing quotas; producer failure cannot block product work.

Backend accepted/confirmed receipt is distinct from browser visible proof. CLI may report `saved, visibility unknown`; never infer rendered success from RPC alone. UI crash before event collection is genuinely unobservable; a later authorized browser receipt reread can emit recovered evidence, not proof of a historical display. The analytics CLI does not gain direct access to financial mutation payloads/receipts; absent sanitized evidence stays insufficient. Ingest rejects, missing terminals, delayed out-of-order events and unsupported old builds remain explicit.

Implementation must extend shared event/property enums, web events/guard contract/service, SQL allowlist by new migration, CLI sanitizer/query/investigate/inspect/audit and code map. Register critical journeys with `fact | hypothesis | insufficient` findings. Every new failure code has origin and UI map. Queries bind parameters, remain SELECT-only and never query user finance/preference contents to diagnose.

Acceptance fixture chain: real typed producer payload → same ingestion guard/storage schema as production → persisted synthetic events → CLI JSON interpretation. Cases: successful visible result; saved with missing applied signal; dropped start; terminal before start; partial finance save; same-request replay; archive retained vs hidden; permission revocation; filtered reorder conflict; disconnected response reconciliation; guarded secret injection rejected; unsupported build stays unknown. `--as-of` fixes evidence window; compare deterministic findings. Synthetic events live only in isolated test storage, not production.
