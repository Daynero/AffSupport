# Recovery contract — 034

Канонічний повний контракт: [036 recovery](../../036-production-acceptance/contracts/recovery.md).
Назви proposed міграцій 036 актуалізовано: full recovery `20261205110000`, delegation `20261206100000` після recurring seam `20261205100000`.

## Перший інкремент: recurring catalogs

- `private.apply_tariff_pauses(team|null)` отримує locks tariff→updater, перечитує effective access,
  переносить лише активні інтервали; дані й профілі не видаляються.
- BEFORE UPDATE тарифу фіксує закритий старий стан до renewal: навіть без pause cron.
- `private.after_space_tariff_change` на closed→allowed відновлює paused recurring schedules у тій самій
  транзакції й використовує чинну sync reconciliation. Active→active не планує додатковий запуск.
- Compatibility `resume_team_catalog_updater` йде через той самий idempotent restore.
- Restore не змінює profile.schedule/version і не торкається disabled/catalog terminal operations.
- Registration/due schedule не є started, completed або delivered. Повний UI/CLI projection дозволений
  тільки після durable lifecycle/diagnostics інкрементів. Старий boolean pause flag сумісний.

Повний one-off/agent recovery, retries/reasons, ACL, retention та UI лишаються обов'язковими за 036.

## Реалізовані seams, інкремент 2

`team-recovery` приймає лише POST та closed actions. Browser JWT доступний тільки для delegate/revoke;
redeem/rotate/probe/claim/heartbeat/checkpoint/settle відхиляють Origin. Claim replay повертає той самий
receipt, execute перевіряє current actor rights, audience, epoch, operation/job. Native credentials не
віддаються браузеру. Серверний `retry_workspace_recovery` повторює лише registration failure/exhaustion.

Нативний executor використовує чинний process bridge/governor; persistent request/rotation IDs записує
до send, active grants — лише в secure storage. Unknown running checkpoint після restart не replay.
Один claim/30 с, probe/60 с, installation rolling limits 12 claims/6 probes за 60 с; transient retries
2/4/8/16/30 с із jitter, більший Retry-After враховується, вихід за episode budget блокує автоматичний
retry. Потрібний explicit retry після exhausted native transport; automatic recovery ніколи не
скидає manual cancellation. Цей консервативний stop ще потребує повного LIFE/LOAD acceptance за 036.

Retry history/attempt/since/not-before зберігаються в atomic native journal. Після exhausted episode
read-only probe може відкрити наступний episode при доступному сервері, загалом до 3/год; restart
не обнуляє цю межу. Membership/role/profile process revocation анулює family й під тарифною паузою.
Manual cancel/permanent failure не replay; новий explicit manual round є новою config generation.
