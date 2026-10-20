# Перевірка 034 recovery

1. `npm run build -w @video-compressor/shared`.
2. `npx vitest run tests/space-tariffs-sql.test.ts --maxWorkers=1` — повний migration chain,
   recurring pause/renewal/undo, expiry до cron, повторне поновлення, manual disable, calendar preservation.
3. Двосесійна перевірка першого інкремента на локальному Supabase Postgres:
   `SOTY_TARIFF_POSTGRES_CONTAINER=supabase_db_wishly npx vitest run tests/tariff-catalog-recovery-postgres.test.ts --maxWorkers=1`.
   Тест створює окрему випадково названу БД і видаляє її у teardown; чинну beta БД/ролі не змінює.
   Без явного container env набір SKIPPED. Повні гонки pause↔renew/stop/set, restart snapshots/receipts — за 036 T024–T032;
   PGlite не замінює їх і не доводить SLO.
4. Після наступних інкрементів: shared/agent/web builds, targeted suites, `npm run verify`.
5. Повна beta: LIFE-021–036 та LOAD-08 за 036, справжній Drive, Safari/Chrome, macOS (live Windows виключено власником),
   agent offline/needs_reauth/permission revoke, output receipt без дублів, delivery/unknown.
6. Exact-SHA packaged beta за docs/BETA.md. Немає commit/Drive evidence — NOT_RUN/BLOCKED,
   ніколи PASS. Production не змінювати.

Фактичні результати пишуться у findings.md з датою та середовищем.

## Локальний durable/native інкремент

`npx vitest run tests/team-recovery-delegation.test.ts tests/team-recovery-handler.test.ts tests/team-recovery-worker.test.ts tests/team-recovery-journal.test.ts tests/tariff-recovery-ui.test.tsx tests/recovery-browser-ownership.test.tsx tests/analytics-tariff-recovery.test.ts --maxWorkers=1`

Real PostgreSQL suite тепер використовує справжній `supabase_vault` і додатково перевіряє encrypted replay,
другий rotation/cleanup, stale lease після closure та repeated renewal. Жодні реальні credentials у fixture
не використовуються. SQL suite також читає отриманий recovery через restricted SELECT-only role й CLI.

`npm run beta:doctor` — readiness/isolation, не acceptance. macOS Keychain synthetic roundtrip доведено
окремо; Windows DPAPI restart/corruption і фактичний Drive delivery потрібні на відповідних стендах.

### Рішення власника: live Windows, 2026-10-20

Власник прямо виключив перевірку на живій Windows-машині: стенду немає. Для завершення **034**
цей варіант має статус EXCLUDED_BY_OWNER, не PASS і не блокер. Windows implementation, platform
capability та автоматичні regression/contract checks залишаються. Це рішення не змінює платформний
склад production artifacts і не підмінює інші незалежні release gates. Решту recovery acceptance
виконувати на доступному macOS/local beta, із явними межами зовнішнього Drive evidence.

### Isolated schema generation and bounded renewal

`SOTY_TARIFF_POSTGRES_CONTAINER=supabase_db_wishly SOTY_GENERATE_RECOVERY_DB_TYPES=1 npx vitest run tests/tariff-catalog-recovery-postgres.test.ts --maxWorkers=1`

Opt-in schema generation uses the same canonical local generator against a randomly named loopback
PostgreSQL database after the full migration chain. It never uses `--linked` and cannot target a hosted
server. The fixture creates ten spaces with five members and three catalogs each, renews each twice,
checks one recovery per space, all thirty schedules and the global twelve-worker lease budget.
This is a deterministic queue-budget proof, not a substitute for the 30-minute hosted LOAD-08 soak
or a claim that external Drive execution meets a five-minute SLO.

### Рішення власника: релізні перевірки відкладено, 2026-10-20

Пряма вказівка: «релізні то перевірки тільки не роби то вже перед релізом потім».
Поточне завершення 034 охоплює реалізацію та звичайний `npm run verify`.
`verify:release`, пакування, exact-SHA packaged beta та релізна LIFE/LOAD кампанія відкладені
до підготовки релізу (T044), не виконуються зараз і не позначаються PASS.
Це не послаблює production promotion gates. Production не змінювався.
