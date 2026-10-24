> **Current scope decision — 2026-10-24:** 036 is CLOSED for completed local implementation and verification. Remaining substantial acceptance obligations are OPEN in [042 Production Readiness](../042-production-readiness/spec.md), with exact mapping in [scope-transfer.json](scope-transfer.json). See [closure.md](closure.md). Earlier full-campaign requirements and NO_GO checkpoints below are retained as historical requirements/evidence for 042; no production GO or test PASS is inferred from this scope change.

# Поточний фокус: два користувачі

Рішення власника 2026-10-21 після reboot: агент перевіряє взаємодію двох користувачів; звичайні однокористувацькі екрани власник перевірить сам за [коротким списком](owner-ui-checklist.md). Це зміна пріоритету й розподілу роботи, не PASS старих невиконаних кейсів.

Дві одночасні реальні Auth-сесії: A — власник, B — учасник. B послідовно отримує admin/editor/viewer та overrides; для перевірки ізоляції кожен має окремий простір. Синтетичний S може лише підготувати тариф поза браузерним workload; третього інтерактивного користувача не потрібно. Safari/Chrome використовуються для A/B, без закриття чужих вкладок. Для сценарію потрібні authoritative readback та серверна відмова після втрати прав, не тільки disabled кнопка.

| ID | Що перевіряє агент | Зв'язок з каталогом | Залежність |
| --- | --- | --- | --- |
| F2-01 | Незалежний вхід, refresh, вихід однієї особи; один beta backend | SET-001–003, SET-007 | local Auth |
| F2-02 | Запросити B редактором, прийняти, повторити; немає другого membership/місця | TEAM-003, TEAM-005, TEAM-009 | beta invitation link |
| F2-03 | Відкликати pending; збережене посилання більше не приймається; race accept/revoke має узгоджений стан | TEAM-007, TEAM-018 | beta invitation link |
| F2-04 | Відкритий редактор B: A змінює роль/overrides; старі Save/Enter і RPC дотримуються нового права | ACL-002–005, ACL-008, ACL-011–013, ACL-016 | accounts/tasks без Drive; файлові дозволи окремо |
| F2-05 | Видалити B онлайн/після reconnect; старі read/write/subscription не дають нових даних; повторне запрошення повертає лише нові права | TEAM-011–013, ACL-014 | local Auth/Realtime |
| F2-06 | Ізоляція просторів A/B: чужий deep link/ID/read/write/live updates; owner-only дії | TEAM-014–015, TEAM-017, ACL-001 | два синтетичні простори |
| F2-07 | Зміна акаунта/денних витрат A↔B; актуальна сума, тег і task link після перенесення | REG-011–012, SYNC-022–023 | accounts/Realtime |
| F2-08 | A створює/призначає завдання B; B змінює стан; A бачить результат, viewer не пише | REG-013, RO-001 | task metadata; attachment потребує Drive |
| F2-09 | Двоє редагують один запуск: збереження, конфлікт revision; права після downgrade | LAUNCH-004, LAUNCH-009–010, LAUNCH-013 | draft без generation/Drive |
| F2-10 | Pause тарифу блокує A/B; продовження повертає доступ за поточними ролями, без чужих приватних admin полів | TARIFF-014, TARIFF-019, LIFE-005–006, LIFE-010, LIFE-013–014 | local tariff preparation; календарні межі не імітуються UI clock |
| F2-11 | Файлові overrides/grants/preview після втрати прав; attachment іншому учаснику | ACL-006–007, ACL-009–010, ACL-015, RO-002–006, REG-013, OBS-005 | BLOCKED без окремого тестового Drive |
| F2-12 | Двоє запускають/спостерігають sync; один закриває вкладку або від'єднує запит, інший не втрачає роботу | SYNC-007, SYNC-016, SYNC-020, SYNC-022 | BLOCKED без тестового Drive; faults лише контрольовані |

Це 12 focused перевірок із власними результатами. Вони не є повним виконанням кожного згаданого оригінального ID: старі триособові, файлові та generation передумови можуть бути ширшими. Старі immutable manifests/runs не редагуються; focused evidence має свій scope і не дає production GO.

Автоматичні regression/static/build/database gates залишаються агенту. Hosted 30/50, 8h soak, Windows, повний backup і exact-SHA package поза поточним двокористувацьким ручним пріоритетом; їх не позначати пройденими. Повний production verdict залишається окремим.

Уточнення розподілу: звичайний перегляд історії та історичної копії запуску є однокористувацьким обходом у списку власника. F2-09 доводить shared draft, concurrent revision guard і downgrade; generation/history invariants початкового LAUNCH каталогу не зараховуються цим PASS.


Після підключення Drive (2026-10-22): F2-11 focused PASS у поточному локальному scope — D31/D32/D33/D41 у drive-ui/report.json. B stale rename повертає403 після revoke edit; download/move меню блокується, view revoke прибирає старі video/table/dialog, старий range grant відмовляє PERMISSION_DENIED; B відкрив вкладення завдання A з readyState4. Початкові editor defaults B повернуто. Це не PASS кожного початкового ACL/RO ID. F2-12 PARTIAL: own folder sync завершився після закриття ініціатора, main A показав завершений sync; вкладки A/B збережено, live progress у B не зараховано; одночасні запити двох різних admins не перевірені (B лишився editor). Попередні записи BLOCKED без Drive історичні. Full036 NO_GO зберігається.

Followup22жовтня: F2-12 API scope PASS: owner A + тимчасовий admin B одночасно запитали sync (135ms), отримали один job, B replay idempotent; після припинення polling A B сам дочекався succeeded, обидва request status підтверджено. Роль B відновлено editor з початковими overrides. Це не доказ видимого progress у вкладці B і не буквальний сценарій двох base-role admins. Доказ concurrent-sync.json у drive-followup.

Followup24жовтня: F2-12 focused owner+admin browser scope PASS. У двох реальних Auth-сесіях A/B одночасний UI sync QA-папки створив один job; B показав «Спільна з 1», live progress і «Завершено» без reload. A натиснув «Зупинити»: сервер підтвердив detached до завершення, запит B лишився joined, той самий job succeeded без error. B повернуто editor/defaults; sync control зник у відкритій вкладці без reload. Дві щойно створені QA-папки прибрано в кошик; оригінали не змінено. Доказ `drive-followup/two-user-shared-sync-20261024.json`. Це A owner + B admin, не два base-role admins; повні початкові SYNC IDs і T178 не закриті. Окремий offline/reconnect прогін частковий: eventual delivery є, але commit-before-restore не доведено. Full036 NO_GO.

T099 execution milestone closed24жовтня: усі12focused scopes мають докази з явними датами21–24жовтня. Consolidated `two-user/focused-completion-20261024.json` preserves historical/current limits; no current-candidate adoption, no original174-case PASS or production verdict.
