# Research — 034, 2026-10-20

## R1 — Чинні розклади
Decision: відновлювати тільки tariff-held items; зберігати per-catalog profile.schedule/version/settings.
Rationale: `20261204160000_catalog_calendar_schedule.sql` додала civil schedule; старий план не враховує DST.
Catch-up — одна round, після неї `private.next_catalog_schedule` продовжує календар.
Alternative rejected: переписати профілі або програти всі пропущені інтервали.

## R2 — Фіксація expiry
Decision: capture до адміністративної зміни закритого тарифу та у pause sweep; повторно перевіряти доступ
після lock. Lock order tariff→updater→items відповідає чинним admin RPC, що вже блокують tariff row.
Rationale: старий sweep вибирає closed без lock, після очікування може призупинити вже продовжений тариф;
renewal до 10-хвилинного cron може пропустити pause capture.
Alternative rejected: лише UI resume або лише пізній cron.

## R3 — Повний recovery — окремі durable інкременти
Decision: повний контракт 036 залишається обов'язковим; recurring restore — лише перший інкремент.
Rationale: старий apply_tariff_pauses очищає round/lease і не має one-off checkpoint, actor чи receipts.
`private.resume_space_sync` dedup pending/leased/retry, але ковтає enqueue exceptions.
Sync має `catalog_sync_authority/lease_epoch`; restitch має lease token/operation IDs.
Alternative rejected: blanket retry завершених/скасованих/unknown operations або друга черга.

## R4 — Агент
Decision: scoped delegation/secure credential storage/durable checkpoint за 036 T033–T040.
Rationale: браузерний `useRestitchPreparer` не забезпечує роботу без вкладки; installation ID не є credential.
Жодних browser refresh/service-role credentials в агенті. До реалізації blocked/unknown — правдивий стан.

## R5 — Докази
Decision: PGlite regressions для SQL, справжні двосесійні тести для locks, live Drive/Windows/beta для delivery.
Rationale: ні emitted browser event, ні queue registration не є proof фактичного старту/результату.
Research виконано локальним читанням коду та окремим research-agent, без production доступу.
