# Data model — 034 recovery

Повна цільова модель: [036 data-model §0–3](../036-production-acceptance/data-model.md).
WorkspacePause/PauseItem мають існувати до renewal; WorkspaceRecovery/RecoveryItem посилаються на pause,
монотонні epoch/config generation/lease fences не копіюють права. Active/waiting snapshots не очищаються;
terminal retention ≥30 днів. Контент, raw paths і credentials у recovery/telemetry не зберігаються.

## Інкремент recurring catalogs

Наявний durable snapshot: `team_catalog_updater_items.paused_interval` (text, не interval),
`team_catalog_updaters.paused_by_tariff_at`; profile.schedule/version/restitch settings зберігаються без змін.
`update_interval != null → paused_interval → update_interval`; disabled item не створюється заново.
Після restore одна due round, наступний civil slot рахує чинний scheduler. Compatibility resume RPC
не запускає нову round для вже відновленого каталогу. Це не повна WorkspacePause/PauseItem модель:
one-off rounds/checkpoints/actor receipts ще потребують інкремента 2.

## Реалізована durable модель, інкремент 2

| Сутність | Збереження та межі |
|---|---|
| `private.workspace_pauses` / `workspace_pause_items` | Atomic capture до clear; identity epoch, tenant FK, resource/kind unique, actor/config generation/початкова round |
| `private.workspace_recoveries` / `workspace_recovery_items` | Одна recovery на pause; pending/leased/waiting/resumed/completed/skipped/blocked/superseded, lifecycle stage, bounded registration attempts |
| `private.team_recovery_enrollments` | 256-bit ticket hash, actor/team/installation, TTL 120 с, одноразове споживання |
| `private.team_recovery_delegations` | Refresh hashes, current/previous rotation, revoke/version, fixed expiry ≤30 днів; replay response зашифровано Vault ≤60 с |
| `private.team_recovery_credentials` | Hash-only claim або execute audience, expiry ≤5 хв; execute прив'язаний до operation/job/epoch |
| `private.team_recovery_claim_receipts` | Idempotent request ID; pending/confirmed, encrypted response; retention 30 днів |
| Native journal | Environment-scoped atomic metadata, до 6 registrations/checkpoints, ≤256 KiB; corrupt file quarantined без replay |
| Native secure store | Keychain / DPAPI CurrentUser; refresh, rotation ID, активні scoped grants; не telemetry/JSON journal |
| `public.analytics_workspace_recovery` | Restricted read-only projection, closed reasons/stages, bounded CLI до 100 items; missing/delivery unknown явні |

Старі running операції без надійного checkpoint/output receipt залишаються blocked; поновлення тарифу не
дає дозволу повторювати невідомі зовнішні side effects. Production застосування й Windows/Drive proof
не випливають із наявності schema. Міграції delegation/lifecycle: `20261206100000` / `20261206110000`.
