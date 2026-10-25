> Historical full-scope design, deferred by the owner’s 3–4h MVP decision. Active requirements: [spec.md](../spec.md). This artifact does not expand the current implementation scope.

# Contract: transactional mini migrations and vendor interoperability

## Supported vendor ledger

Mini executor підтримує вузький adapter `supabase-history-v1` до configured pinned `supabase@2.117.0` (поточний pin `scripts/lib/release/adapters/supabase-backend.mjs`). Зміна pin/schema — новий adapter/evidence, не автоматична сумісність. Server PostgreSQL major/image digest фіксується у enrollment manifest та має пройти той самий real interoperability test, що target; unsupported major/schema → `MIGRATION_LEDGER_UNSUPPORTED` до write.

Supported target table: `supabase_migrations.schema_migrations`; unique/primary `version` text або varchar, `name` text, `statements` text[]. Нові mini version — точно 14 decimal timestamp digits із basename `<version>_<name>.sql`; name непорожній safe slug, duplicate version/name rejected. Legacy rows з коротким version/NULL statements не редагуються й потребують trusted baseline schema/source attestation; вони не стають доказом source checksum. Додатковий unknown required column/trigger/policy, несумісний constraint/type, відсутній table або несподівані ledger write effects блокують adapter. Mini не створює/repair/alter vendor ledger у production.

Canonical tuple **генерує офіційний pinned CLI у disposable rehearsal**, застосовуючи exact reviewed migration file на baseline schema. Після застосування з його ledger зчитуються version/name/ordered statements text[], schema/CLI/PG fingerprints і raw source SHA-256; весь tuple зберігається у приватному candidate artifact і хешується. Ordered statements беруться з vendor, не самописного `split(';')`. Missing/NULL statements або невалідний vendor tuple → blocked. Policy перевіряє саме ці statement bytes і source hash, включно з dollar quoting та function signatures. Export reports містять digest, а не SQL content.

Production executor виконує exact vendor-generated statement array один statement за запитом у транзакції, потім INSERT **того самого** version/name/statements tuple у тій самій транзакції. INSERT параметризований; `ON CONFLICT DO NOTHING`, UPDATE/DELETE history та repair заборонені. Достатні права: intended reviewed DDL/object rights, ledger schema USAGE і table SELECT/INSERT; analytics role/URL заборонені. Privilege/schema/endpoint capability перевіряється до write. Fresh history+normalized schemaDefinitionDigest/postconditions independent observation потрібні після COMMIT. Local receipt alone недостатній.

Якщо statement representation не відповідає exact source згідно vendor fixtures, історія target не збігається з trusted baseline або applied source file змінився, admission відмовляє. Джерело immutable content — frozen git та trusted baseline receipts; vendor ledger не має вигаданого checksum column.

## Absolute deadline semantics

Global apply deadline = start +120 s, кожна migration transaction = start +30 s, із 5 s резервом на ledger/history/COMMIT і bounded initial observation. Бюджет не перезапускається між statements. Перед **кожним** reviewed statement, ledger INSERT і COMMIT executor обчислює remaining за monotonic clock та встановлює server-side statement timeout ≤ min(30 s, transaction remaining, global remaining), а lock_timeout ≤ min(2 s, statement remaining). Перед application SQL має залишатися весь 5 s reserve; інакше explicit ROLLBACK без нового statement. Policy забороняє самим statements змінювати transaction/timeouts або обходити їх через dynamic SQL.

No pipelined multi-statement query. SET LOCAL budget verification також bounded; inability to enforce → `DB_BUDGET_UNENFORCED`. Довгий DO/function body має один server-side timeout. Budget extension/retry не допускається без нового admission. Якщо COMMIT observation втрачена або transport висить до абсолютного deadline, стан unknown; нові writes заборонені, можливе лише bounded fresh read-only reconciliation. Deadline обмежує allowed work/acceptance window, не обіцяє миттєвої зупинки невідомого COMMIT у недоступній БД.

Real tests використовують зменшені policy budgets із тією самою пропорцією reserve. Обов'язковий multi-statement migration: кожен statement коротший per-statement max, але сума перевищує transaction/global budget; executor abort до наступного statement, application changes та ledger row відсутні після rollback. Окремо COMMIT response lost: жодного blind replay, факт доводиться незалежним history+schema/data read.

## Required real interoperability acceptance

1. На disposable PostgreSQL із target-compatible version/schema pinned CLI створює baseline і генерує canonical tuple для candidate A.
2. Mini writer застосовує A на окремій baseline clone; ledger tuple, schema та postconditions збігаються з vendor result.
3. Pinned CLI `migration list`, `db push --dry-run` і чинний backend planner читають A як applied без repair; жодного повторного pending A.
4. Додається full-release migration B; pinned CLI реально застосовує B після A. Обидві ledger rows і схема коректні; A не повторюється.
5. Помилка всередині A відкатує schema **і** ledger atomically; edited source A, vendor tuple drift, wrong project, extra pending та incompatible history schema rejected.

Це обов'язковий blocking integration test, не лише unit mock або сформульоване припущення про формат. Непройдений test не дозволяє DB mini activation навіть за working web-only mode.
