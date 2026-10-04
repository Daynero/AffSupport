# Finance API and export contract

Усі назви — нові заплановані RPC. Використовувати чинний Supabase client та TeamApiError; SQL errors map-яться у стабільні коди. Кожен виклик перевіряє поточний доступ до team; anonymous заборонено.

## Типи

- CalendarDate: валідний Gregorian YYYY-MM-DD.
- Metric: balance | topup | spend.
- Money: decimal string із двома знаками, 0.00..999999999.99, або null. UI приймає кому, нормалізує до крапки. Жодного Number(input) для арифметики.
- Version: невід'ємний decimal integer string; відсутнє поле має "0".
- Field: agentRowId, date, metric, value, currency="USD", version, placementId, updatedAt, updatedBy.
- MutationResult: requestId, fields[], placementVersion, undoReference (original requestId після змістовного clear; null для інших змін/no-op); повертається збережена квитанція повтору, не новий фінансовий запис.
- Request: UUID, згенерований один раз на намір; retry має той самий UUID і payload, нове редагування — новий UUID.

## Операції

| RPC                              | Input                                                                                                       | Output / behavior                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| get_team_agent_finance           | team, from, to, timezone                                                                                    | FinanceSnapshot; view; завершений діапазон до 366 включних днів              |
| set_team_agent_finance_value     | team, agent, date, metric, value, expectedVersion, timezone, requestId                                      | MutationResult; edit; null = clear                                           |
| clear_team_agent_finance_values  | team, date, metric(balance/topup), fields[{agent,expectedVersion}], timezone, requestId                     | атомарний batch і undo reference; список максимум 500 агентів                |
| undo_team_agent_finance_clear    | team, originalRequestId, requestId                                                                          | одиночний або batch clear відновлено з CAS; edit; тільки автор clear         |
| move_team_account_agent          | team, agent, targetAccount, effectiveOn, expectedPlacementId, expectedPlacementVersion, timezone, requestId | той самий agent summary + новий placement; edit                              |
| list_team_agent_finance_history  | team, agent, cursor?, limit=50                                                                              | events[], transfers[], nextCursor; maximum 100; view; stable cursor(time,id) |
| list_team_agent_finance_legacy   | team, agent?                                                                                                | недатовані оригінали та статус кожного metric; view                          |
| import_team_agent_finance_legacy | team, legacyId, metric(balance/topup), date, confirmedAmount, currency, timezone, requestId                 | MutationResult; edit; одноразово, без overwrite існуючого поля               |

`FinanceSnapshot`: schemaVersion=1, teamId/name, from/to inclusive, currency, generatedAt, accounts[], agents[], placements[], fields[]. Names/IDs — текст. Порожні поля можуть бути відсутні, клієнт підставляє null/version0 тільки для реально відсутнього рядка; tombstones повертаються з їхньою версією. Колонки звіту — унікальні пари (accountId, agentRowId), для яких хоча б один placement перетинає період, а не наявністю ненульової суми. Підсумки обчислюються з snapshot точними cents спільною чистою функцією; balance не підсумовується між днями.

Snapshot створюється одним SQL statement з перевіркою membership та єдиним MVCC snapshot. Не складати аркуші з незалежних RPC. Журнал пагінується окремо та не входить у місячний snapshot. Підсумки не залежать від пагінації журналу чи видимих рядків UI.

## Створення агента та Undo

Чинний add_team_account_agent отримує optional p_timezone (IANA, default UTC) зі збереженням старих параметрів і return shape. Browser addAccountAgent передає timezone пристрою через useAccounts та форму створення. SQL перевіряє timezone та атомарно створює агента й початковий placement із датою server created_at у цьому timezone. Стару сигнатуру замінити без неоднозначних overloads; omitted timezone старого клієнта означає UTC. Invalid timezone відхиляє всю операцію. Starts_on повертається у finance placement DTO та не перераховується при іншому timezone читача.

set_team_agent_finance_value(value=null) після змістовного одиночного clear будь-якого metric повертає undoReference. undo_team_agent_finance_clear працює для цього reference та batch reference: тільки автор з чинним edit; усі поточні versions повинні дорівнювати versions після clear. Новіша зміна — FINANCE_CONFLICT, без записів. Повтор того самого Undo request повертає його receipt; новий request для вже скасованого clear — FINANCE_UNDO_ALREADY_APPLIED. No-op clear не пропонує Undo. Одиночний Undo реалізується в US1, batch підтримка — в US5.

## Помилки

INVALID_INPUT, INVALID_DATE, FUTURE_FINANCE_DATE, DATE_BEFORE_AGENT, FINANCE_AMOUNT_INVALID, FINANCE_CONFLICT, ACCESS_DENIED, NOT_FOUND, AGENT_ID_CONFLICT, PLACEMENT_CONFLICT, TRANSFER_DATE_INVALID, FINANCE_HISTORY_PROTECTED, REQUEST_REUSE_CONFLICT, LEGACY_ALREADY_IMPORTED, LEGACY_TARGET_OCCUPIED, FINANCE_CLIENT_UPGRADE_REQUIRED, FINANCE_UNDO_ALREADY_APPLIED.

FINANCE_CONFLICT повертає актуальні fields для авторизованого користувача. UI зберігає його draft і пропонує перечитати/повторити після порівняння; не робить автоматичного force overwrite. Invalid timezone — INVALID_INPUT. Недоступна сутність іншого team не розкриває назву/історію.

## Excel endpoint

`POST /functions/v1/team-finance-export`, bearer JWT користувача; body `{teamId, from, to, timezone}`. Handler використовує user-scoped RPC, не service-role bypass. Перед віддачею повторно перевіряє view; відсутність доступу або помилка rerecheck не повертає файл.

Success 200: MIME `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, Content-Disposition attachment із безпечним UTF-8 filename, Cache-Control private,no-store. Файл не зберігається на сервері після відповіді. Помилки JSON `{error: code}`: 400 invalid period, 401 unauthenticated, 403 denied, 409 precision/size unsupported, 500 export failed. Browser перевіряє status/content-type перед створенням download Blob; відкликає object URL після завантаження.

Аркуші в порядку: Спенди, Поповнення, Залишки, Виписка поповнень, Підсумки. Перші три: metadata у рядках 1–3, соц у рядку 4 (merge по агентах), agent full ID у рядку 5, дані з рядка 6; A — ISO date text, B+ — колонки унікальних пар (accountId, agentRowId); усі повторні placements пари об'єднані. Freeze top 5 rows + column A. У чисел формат 0.00, null клітинки пропущені; нуль явно записаний. Після останньої дати рядок підсумку тільки для spend/topup. ID та всі назви записані як string, без формул, зі збереженням початкових нулів.

Виписка: дата, соц, повний ID, поповнено, USD; одна актуальна сума на агент/день, включно з явним нулем. Підсумки: scope(account/agent/team), name, ID, spend, topup, USD. Агент після перенесень один у summary, один раз під кожним відповідним соцом у matrix, включно з поверненням X → Y → X без повторної колонки X, без подвійних сум. Сортування natural account/name та agentId, остаточний tie-break UUID.

До генерації перевірити ліміт колонок/рядків формату та точність усіх числових клітинок, включно з totals. Непредставимі точно cents не округлювати: EXPORT_PRECISION_LIMIT; надмірна ширина — EXPORT_SIZE_LIMIT. Поточний writer доповнюється стилями/мерджами, старий buildXlsx і catalog exports не змінюють контракт.
