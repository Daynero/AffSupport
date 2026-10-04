# Data Model

Назви нижче — заплановані. Усі tenant references включають team_id; money values не залежать від видимого ID агента.

## Сутності

| Таблиця                     | Поля й ключі                                                                                                                                           | Обмеження                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| team_agent_placements       | id, team_id, agent_row_id, account_id, starts_on date, ends_on date/null, version, created_by, created_at                                              | [start,end), start < end, один відкритий період на агента, без перекриттів                                  |
| team_agent_finance_values   | id, team_id, agent_row_id, placement_id, entry_date, metric, amount_cents bigint/null, currency, version bigint, updated_by, updated_at                | unique(team,agent,date,metric), metric = balance/topup/spend, 0..99999999999 cents або null, currency = USD |
| team_agent_finance_events   | id, team_id, agent_row_id, placement_id, entry_date, metric, old_cents, new_cents, previous_version, new_version, actor_id, occurred_at, request_id    | append-only; містить і очищення, і Undo                                                                     |
| team_agent_transfer_events  | id, team_id, agent_row_id, from_placement_id, to_placement_id, effective_on, actor_id, occurred_at, request_id                                         | append-only, одна подія на успішне перенесення                                                              |
| team_agent_finance_legacy   | id, team_id, agent_row_id, account_id, captured_at, balance_units, requested_topup_units, balance_imported_event_id/null, topup_imported_event_id/null | первинні суми незмінні, незалежне одноразове підтвердження кожного поля                                     |
| team_agent_finance_requests | team_id, actor_id, request_id, operation, payload_fingerprint, result, created_at, undone_by_request_id/null                                           | unique(team,actor,request), та сама key з іншим payload — помилка                                           |

Початкова версія відсутнього поля — 0; перша збережена зміна — 1. Clear зберігає рядок із null та новою версією. Відсутній рядок і tombstone однаково виглядають у календарі, але мають різні CAS versions. No-op із тим самим значенням не створює фінансову подію, проте receipt дає повторювану відповідь.

## Ідентичність та історичні назви

Наявний `team_account_agents.id` не змінюється. Додати composite unique(id,team_id), де його бракує, для tenant FKs. Видимий agent_id і назви соц можуть змінюватися; звіт використовує поточні назви сталих сутностей, журнал перенесень додатково зберігає текстові назви на момент події для пояснення. Перейменування не змінює суми, дати або account UUID.

Перенесення оновлює тільки поточний account_id і placement state. Runs, markers, task tags та labels залишаються на тому самому agent UUID. Наявна unique(account_id,agent_id) визначає конфлікт призначення.

## Календарні дати

entry_date і starts_on — date, не timestamp. Клієнт передає IANA timezone; сервер обчислює today з власного часу в цьому timezone, не довіряє client today. ISO-дата не конвертується при читанні.

Для старих агентів початкова дата розміщення — UTC calendar date їхнього created_at, зафіксована міграцією та позначена як imported baseline; продукт не має збереженого історичного timezone. Це правило лише задає найранішу відому дату існування, не приписує старим грошам дату. Нові агенти отримують дату створення у timezone створювача; чинний add_team_account_agent розширюється optional p_timezone з default UTC, клієнт передає валідний IANA timezone. Замінити стару сигнатуру міграцією, не залишати неоднозначних overloads; зберегти старі параметри/return shape і права. Сервер обчислює starts_on з власного created_at в p_timezone, не приймає довільну дату народження; наявні старі виклики створення без timezone використовують UTC. UI повідомляє найранішу допустиму дату, якщо користувач намагається внести давніший запис.

## Транзакції

### Збереження одного показника

1. Перевірити actor, право edit і tenant; взяти agent row FOR UPDATE.
2. Знайти receipt: той самий payload повертає збережений результат, інший — REQUEST_REUSE_CONFLICT. Перевірка доступу виконується й для повтору.
3. Перевірити дату, суму, timezone та placement на дату. Заборонити майбутні й дати до початку історії.
4. Порівняти expected_version конкретного поля; відмінність — FINANCE_CONFLICT з актуальним полем.
5. Записати значення, version+1, подію й receipt в одній транзакції. Помилка відкочує все.

### Clear та Undo

Одиночний clear виконується через set_team_agent_finance_value(value=null) для balance/topup/spend. Якщо непорожнє значення очищене, receipt зберігає old value, отриману version та undo reference; no-op clear не створює undo reference. Спільний undo_team_agent_finance_clear приймає receipt одиночного або batch очищення, перевіряє edit, авторство та незмінність усіх отриманих versions; повтор Undo з тим самим requestId повертає receipt, а інший requestId для вже скасованого clear повертає FINANCE_UNDO_ALREADY_APPLIED. Undo атомарно позначає original receipt як скасований.

Для batch передається явний список (agent,metric,date,expected_version). Locks агентів у порядку UUID; усі permissions/versions перевіряються до зміни. Batch атомарний. Receipt містить знімок попередніх значень та отримані versions. Undo посилається на original clear request, очікує саме отримані versions, пише нові події; якщо хоч одне поле вже змінене — увесь Undo відхиляється з конфліктом. Без hidden partial success.

### Перенесення

Lock source/target accounts у порядку UUID, потім agent. Delete account використовує той самий порядок locks. Перевірити expected placement/version, target tenant, колізію ID, дату > start і > усіх дат values/events поточного placement. End старого placement = effective_on, start нового = effective_on; update account_id + transfer event + receipt атомарні. Внесення заднім числом бере відповідний старий placement; move не переприв'язує жодних сум.

### Legacy import

Lock agent і legacy row; перевірити ще не імпортований metric. Користувач явно підтверджує дату, USD та фактичну суму. Існуюче денне поле не перезаписувати: повернути LEGACY_TARGET_OCCUPIED і запропонувати ручне узгодження. Створити value/event/receipt, позначити імпортований metric. Оригінальна недатована сума зберігається. Повтор не створює другу суму.

## Доступ, видалення та індекси

Усі public finance tables: ENABLE/FORCE RLS, revoke all; authenticated має лише потрібні SELECT columns під private.can(team,'view',auth.uid()). INSERT/UPDATE/DELETE тільки через security definer RPC з search_path = ''. Журнал/receipt не допускають клієнтських змін; receipt повертається лише автору відповідної операції. Actor references не повинні блокувати видалення користувача: nullable actor UUID із ON DELETE SET NULL, читабельна позначка «колишній учасник».

Financial values/events/legacy references на agent/account — DEFERRABLE INITIALLY DEFERRED NO ACTION, а прямий team FK — ON DELETE CASCADE. Placement-only rows можуть каскадно видалятися разом з агентом без фінансової історії. SQL delete RPC дають FINANCE_HISTORY_PROTECTED раніше за FK error; deferred constraints захищають і обхідний cascade. Історичні account references мають існувати також для legacy та placements фінансових записів.

Штатне явне видалення team видаляє і фінанси в одній транзакції. `delete_draft_team` блокується при фінансових/legacy записах, щоб shortcut видалення порожнього простору не обходив підтвердження. Це обов'язково перевірити на реальному PostgreSQL, включно з усіма чинними шляхами видалення.

Індекси: values(team_id,entry_date,agent_row_id,metric), events(team_id,agent_row_id,occurred_at,id), placements(team_id,agent_row_id,starts_on), placements(team_id,account_id), transfer events(team_id,agent_row_id,effective_on), legacy(team_id,agent_row_id). Неперекриття placement перевіряється під agent lock і DB constraint/trigger; direct writes заборонені. Future migration writes проходять той самий invariant.

## Групування звіту

Колонка має ключ (account_id, agent_row_id), а не placement_id чи видимий agent_id. Placements визначають історичну належність кожної дати; усі періоди однієї пари об'єднуються в її колонці. У X → Y → X записи першого й останнього періоду X потрапляють в одну колонку X/A. Пара включається, якщо хоча б один її placement перетинає період звіту, навіть без сум. Підсумок агента об'єднує різні соци, рахуючи кожен денний запис один раз.

## Міграція й rollout

В одній транзакції заблокувати старі money writes, скопіювати ненульові legacy pairs за сталим ключем агента, створити baseline placements, замінити set_team_agent_money / clear_team_agent_topups / clear_team_agent_balances на fail-closed stubs, додати delete guards. Null/null не створює фальшивої грошової історії. Колонки balance/topup лишаються frozen legacy, не dual-write.

Далі оновити DB types, web client, export function/config і перевірити local beta. Старий frontend може читати legacy колонки, але запис отримує upgrade error. Новий читає money лише з finance RPC. Відкат UI не повертає старі write RPC: до forward fix фінансове редагування закрите, усі журнали та нові суми збережені. Схему з користувацькими записами не drop-ати як rollback; процедуру документувати в ROLLBACK.md.
