# Research: рішення для 036

Досліджено локальний код 2026-10-14. Це факти реалізації й рішення дизайну, не результати runtime acceptance. Нижче зафіксовано проєктні рішення, що потребують реалізації та перевірки; доступність hosted/Windows/Google credentials лишається перевірною передумовою виконання.

## R1 — Один серверний власник recovery

**Decision**: розширити `private.after_space_tariff_change` durable recovery intent та epoch, з окремим обмеженим виконавцем. Тариф продовжується навіть якщо залежність недоступна; помилка постановки/виконання лишається в durable intent.

**Evidence**: `20261130100000_space_tariffs.sql` викликає pause/reconcile на зміні фактичного доступу; `20261130110000_space_tariffs_background.sql` має manual resume. `resume_space_sync` перехоплює enqueue exceptions і повертає null — це не доказ відновлення.

**Rationale**: не потрібна відкрита вкладка; повторний webhook/адмінський виклик/restart не дублює роботу. Несплата визначається строком, не платіжним webhook: останнього в продукті немає.

**Alternatives considered**: автоматично натиснути чинну кнопку з React effect — відхилено через залежність від браузера й дублювання; запуск усіх каталогів зараз — відхилено через burst.

## R2 — Provenance та fencing перед очищенням стану

**Decision**: зберегти тип паузи, config generation, активний round/operation/checkpoint і output receipts до очищення leases; спільний порядок locks для pause/renew/stop/set-interval. Старі claims/finalize відхиляються за epoch/config generation. Поновлення без уже виконаного cron також фіксує проміжок втрати доступу.

**Evidence**: `apply_tariff_pauses` зберігає interval, але очищує round_due_at/attempts/leases. Разові rounds без interval можуть втратити provenance. `stop_team_catalog_updater` очищує маркери й потребує узгодження lock order. Глобальні housekeeping paths можуть збільшувати attempts ще до access filter.

**Rationale**: існуючого paused_interval недостатньо для «все продовжилося». Тарифне очікування не повинно вичерпувати retry budget.

**Alternatives considered**: один boolean на просторі; blanket retry усіх failed jobs — відхилено через втрату ручного наміру й побічні дії.

## R3 — Закритий браузер та агентні процеси

**Decision**: для агентної частини додати scoped delegation і durable background executor у наявному team-bridge. Серверні claims єдині для браузерного й агентного виконавця. Агент не отримує service-role або загальний browser refresh token. Відсутній зареєстрований executor означає waiting_dependency, а не completed.

**Evidence**: `apps/web/src/team/catalog-updater/useRestitchPreparer.ts` керує polling/lease/heartbeat/agent/finalize з браузера; `apps/agent/src/team-bridge/restitch-prepare.ts` не працює із Supabase, стан у пам’яті. IndexedDB `WorkspaceOperationsProvider` не доводить restart/cross-browser durability. `queue/queue.ts` generic recovery не є tariff recovery.

**Rationale**: потрібна робота без вкладки та без копіювання широких користувацьких повноважень. Delegation видається під час явного підключення агента/ввімкнення фонового режиму; не потребує повторного натискання після кожної оплати.

**Alternatives considered**: лишити вкладку обов’язковою — не виконує прийняту вимогу; зберігати токен браузера в агенті — надмірні повноваження. Серверне кодування медіа — не відповідає локальній архітектурі та бюджету.

## R4 — Зберегти чинні обмеження scheduler

**Decision**: updater 12 global live leases, sync 3 global та одна активна робота на connection; coalesce missed intervals в один поточний прохід. Recovery queue використовує ті самі budgets і справедливість між командами.

**Evidence**: claim functions у background migration; наявний PowerGovernor для локальних heavy children.

**Rationale**: renewal не має створювати окремий некерований канал навантаження. Порогові 60 с/5 хв доводяться навантаженням; «queued» не рахується «started».

**Alternatives considered**: підняти concurrency заради тесту без вимірів — відхилено.

## R5 — Керований час без production bypass

**Decision**: автоматичні boundary тести використовують наявний p_at та dates навколо Kyiv today; для живих триклієнтських переходів додати єдиний tariff-domain time seam і local-only SQL overlay. Overlay встановлює fixture writer тільки на loopback, зберігає hash змінених функцій та видаляється teardown. Product implementation повертає реальний server time; користувач не може задати його параметром або session config.

**Evidence**: `private.space_tariff_state(p_at)`, `kyiv_today(p_at)`, але gateway має прямі now(); заміна лише UI годинника не змінить серверні права. `tests/space-tariffs-sql.test.ts` вже перевіряє dates/p_at.

**Rationale**: перевіряємо D+4 та DST швидко, не змінюємо Mac/JWT/lease clock. Усі gateway/notice paths переводяться на одну доменну оцінку; тест доводить їхню узгодженість. Реальний-time smoke без overlay обов’язковий перед packaging.

**Alternatives considered**: глобальний clock override, public debug RPC, fake browser clock — відхилено.

## R6 — Beta email та telemetry потребують capture

**Decision**: окремі loopback-only adapters для rendered mail і typed diagnostic events; звичайна beta analytics лишається вимкненою. Діагностичний capture проходить ту саму validation/redaction/ingestion логіку й потрапляє до локальної тестової бази, яку читає штатний CLI; fixture transport має explicit capability й відхиляє non-loopback.

**Evidence**: `tests/beta-analytics.test.ts` забороняє beta analytics навіть із flag=true. `tariff-notices/handler.ts` у beta позначає лист skipped; injectable send/claim/finish/now та `buildTariffNoticeEmail` придатні для recording adapter. Auth catcher не перехоплює прямі сторонні листи.

**Rationale**: сам факт emit не доводить diagnosis; локальні credentials доставки не потрібні. Втрата capture event дає unknown, а не PASS.

**Alternatives considered**: увімкнути production analytics на beta або справжній email provider — відхилено.

## R7 — Ціль ресурсних вимірів перевіряється окремо

**Decision**: load runner має власний test-target manifest; management metrics читаються тільки з explicit verified acceptance binding, не неявного production binding. Стандартний beta runner лишається loopback-only.

**Evidence**: `scripts/analytics/database-health.ts` для management бере `activeBinding().supabaseProject`, тоді як SQL використовує ANALYTICS_DATABASE_URL. `beta-reset.mjs` захищає destructive reset до першої дії. Наявні health commands не дають всіх CPU/IO/egress метрик.

**Rationale**: уникнути змішування production метрик із тестовим трафіком. Hosted capacity не доведено локально. Невідома квота лишається unknown.

**Alternatives considered**: послабити beta guards або навантажувати production — відхилено. Ціни/квоти з capacity-plan повторно перевіряються на дату execution.

## R8 — Реальні браузери плюс синтетичний масштаб

**Decision**: native Safari A/B й Chrome C для семантики; authenticated protocol clients і справжні Realtime subscriptions для 30/50, із offered/achieved throughput, end-to-end latency, failure та missing delivery.

**Evidence**: reusable interleaving/lifecycle SQL helpers є в tests/support; спеціального 30/50 harness немає. PGlite stubs cron/Vault/HTTP не доводять hosted поведінку.

**Rationale**: жодні три сесії не є load proof, а WebKit-емуляція не є native Safari proof. Артефакт окремо вказує вид тесту.

**Alternatives considered**: лише API reads, без авторизації/підписок, або лінійне множення трьох сесій — недостатньо.

## Уточнення після consistency analysis

- **I1 — права**: renewal повертає можливість роботи за актуальними permissions; snapshot не відновлює членство, grants чи revoked delegation.
- **U1 — credentials**: paired local ticket → browser delegate → agent redeem; ClaimCredential не потребує ще не виданого lease, OperationCredential видається після claim. TTL і lost-response rotation визначені у contracts/recovery.md. Pairing proof не є hardware attestation.
- **U2 — snapshot**: WorkspacePause/PauseItem зберігаються до lease clear і незалежно від renewal; recovery посилається на них. Це закриває crash і expiry-before-cron, не вимагаючи наперед створювати recovery.
- **G1 — hosted**: fixtures самі не доводять готовність runtime. Окремий prepare розгортає exact candidate й виконує synthetic smoke; read-only verify перевіряє identity/readiness, local beta guards незмінні.
- **I2 — SHA**: EvidenceAdoption є вузьким reviewed винятком для незалежного P1; immutable source, closure hashes та заборонені категорії валідовані. Критичні докази завжди нові.
- **G2 — UI**: protocol harness дає серверне навантаження; native Safari/Chrome probes окремо вимірюють видимий правильний результат і не відкидають timeouts.
- **U3 — budgets**: точні request/retry/lease/rotation межі винесено у recovery contract; counters входять у діагностику та capacity forecast. Їхня достатність для 30/50 людей ще має бути виміряна.

Ці рішення усувають прогалини документів; вони не є доказом реалізованої безпеки, відновлення чи достатності тарифу Supabase.
