# Effective creation day

Owner request: creating a SOC or RK while viewing yesterday makes it exist from yesterday onward, never before. The selected day at submission is authoritative; a range/month uses its selected anchor day. Creation in the future is rejected. Physical created_at remains the actual audit timestamp, distinct from starts_on.

Implementation:

1. Pass selected day and finance timezone through UI → AccountsClient → typed RPC boundary, for both SOC and RK; refresh finance placements after acceptance.
2. Add nullable effective starts_on columns in a new migration. Existing undated rows remain undated and retain historical behavior; new normal RPC creation assigns selected day or timezone-local today. Initial RK placement and parent identity history begin on that effective day atomically.
3. Extend an explicitly dated SOC's start when accepting an older RK. An undated legacy parent remains unknown/unbounded; the explicitly dated child proves it existed on that child's day. Audit times and archive/restore event times do not move.
4. Filter overview, day/month UI and finance report/copy/export consistently. Reject finance writes before an explicit birth, including correction paths, while preserving accepted idempotent receipt replay and legacy history.
5. Preserve order, folds, labels and all existing money. No production migration/reset/release; apply only the new migration to the existing local beta after isolated DB tests.

Acceptance:

- SOC and RK created in yesterday are immediately visible and editable yesterday, visible today and after, absent the day before. Reload agrees.
- Empty SOC follows its effective birth too; a populated SOC cannot hide a valid backdated child.
- New RK under explicitly newer SOC extends the parent's birth; legacy-parent case remains visible without rewriting unknown historical data.
- Leap day, invalid/future dates, timezone near midnight, permission denial and archived parent are validated at server boundary.
- Initial placements and effective birth agree; normal/correction prebirth money is rejected; no earlier amounts leak through copy/export.
- Archive/restore history still respects its existing dated events and same-day financial retention.

Diagnostics: reuse correlated retained_action requested → accepted → applied/terminal and closed existing failure codes. Carry only the existing safe account_day enum (today/previous/historical), never literal dates, names or identifiers as telemetry. Overview/date/finance stage evidence remains independent; missing server response or finance refresh is not claimed as visible success. Verify emitted bucket survives producer/consumer sanitizer and diagnostic registry; existing UNKNOWN behavior remains explicit.
