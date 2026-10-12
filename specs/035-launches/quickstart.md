# Quickstart — перевірка майбутньої реалізації

На момент створення плану Launch UI/RPC/міграцій немає. Нижче сценарії для implementation acceptance, не звіт про вже запущені перевірки. Fixtures мають містити лише синтетичні URL/дані; production analytics/database тут не використовуються.

## Підготовка

Потрібні Node за package.json, installed workspace dependencies, локальна БД/Beta за docs/BETA.md, owner/editor/viewer двох test spaces, соц g1 і РК 1234567892, test video material та catalog/restitch defaults. Для restitch — підтриманий локальний агент; для «Інше» не потрібний. Не запускати beta:reset без наміру скинути тестові дані.

Після реалізації та створення відповідних тестів:

```bash
npm run build -w @video-compressor/shared
npx vitest run tests/launch-generators.test.ts tests/launch-url.test.ts tests/launch-state.test.ts --maxWorkers=1
npx vitest run tests/launch-ui.test.tsx tests/launch-persistence.test.ts tests/launch-catalog.test.ts --maxWorkers=1
nice -n 15 npm run verify
nice -n 15 npm run verify:release
```

Назви launch tests — заплановані; відсутність цих файлів зараз очікувана. Existing regressions: product-catalog-handler/parity/xlsx, task attachment/date controls, team operation cancellation. Команди heavy запускати послідовно. `npm run beta:doctor`, `npm run beta:up` — чинний шлях до інтерактивного local acceptance; packaged evidence за runbook після готової реалізації.

## Сценарії

1. **Other end-to-end.** Створити g1-892/video_5, ProCaps TR, patrik, N3/max30/ads3/M45, Advantage off, date2026-10-13. Exact budgets 10/20/30, names із §9 spec; один URL; нуль catalog calls. Generate коротко показує accepted/work → result, поля locked.
2. **URL invariants.** Виконати golden vectors contracts/ui-and-url.md; comparison untouched raw substrings, не лише semantic URL equality. Вставити synthetic token marker; перевірити його відсутність у diagnostics/audit/list/Realtime.
3. **Required/normalization.** Порожні required orange, populated valid очищує accent. `creative test`→`creative_test`, `Відео`/Buyer `роман` блокує Generate на web/Edge. Порожні SUB і assignee дозволені за контрактом.
4. **Defaults/copy/filter.** Save defaults, new Launch отримує їх, existing не міняється. Copy створює незалежний tomorrow/todo draft без files/results; double-click дає один copy. Calendar/Yesterday/Today у визначеному порядку, date filter до pagination.
5. **Manual outputs.** Edit кожний result field; copy current value до save; orange badge/reset/save/reopen. Catalog не змінюється від ручної правки назви/URL. Concurrent save дає conflict, не overwrite.
6. **Catalog.** N кампаній створює одну variation. Copy link дорівнює Google Drive webViewLink. Restitch off пропускає local work; on показує фактичні етапи та minutes config. Не показувати fixed 30% із старого catalog adapter як вимір.
7. **Recovery injection.** Перервати відповіді після provider create, finalize, catalog link і Launch commit. Reload/retry reconciles same logical operation; не другий варіант. Two launches same video reserve distinct variants. Child succeeded без catalog link не дає ready.
8. **Cancel.** Скасувати на підготовці, restitch, Drive create, finalize/link; previous result/draft відновлюється після settlement. Cleanup видаляє лише owned unpublished outputs; sharing rollback не знімає чужий permission. Unknown outcome показаний; late fenced executor не публікує result.
9. **Edit dependency.** Age/budget/ads → лише text revision; Buyer у невикористаному SUB не змінює catalog. Changed URL → new catalog with reused restitch; changed material/version → affected processing. Old catalog лишається.
10. **Archive.** Перевірити catalog і historical catalog коли active method=other. Warning + unchecked checkbox. Cancel не запам'ятовує preference; archive+checked приховує наступне warning тільки для того самого user/team. Catalog/video лишаються на Drive.
11. **Permissions/transport.** Viewer, cross-team IDs, blocked space, removed member, source permissions, two tabs. No URL у safe projection; no extra recurring polling; reconnect/foreground rereads authoritative state.
12. **Diagnosis.** Failure, delayed/lost terminal, result committed without rendered, canceled cleanup. `npm run analytics -- inspect <test-flow-id> --json`, `investigate <test-subject> --json`, `audit --period 7d --json` лише зі свідомо налаштованим read-only test connection. CLI називає stage/cause або insufficient, не вигадує нуль проблем. Не перемикати CLI на production для цих сценаріїв.

## Exit criteria

AC-01–46 зі spec звірені з реальними сценаріями, targeted tests та verify forms green, source→guard→CLI coverage доведено. Production gates: external tracker contract для підписаних URLs і узгоджена видимість original URL у доступній за посиланням таблиці. Beta verification не замінює цих продуктових рішень і не є дозволом на production release.

## Додаткові регресії після аналізу задач

13. **Autonomous recovery.** Прибрати з test fixtures усі scheduled updater/retired-copy jobs; лишити один due Launch recovery або cleanup, закрити UI. SQL dispatcher має викликати endpoint і settle-ити допустиму роботу. Повторний tick не створює другий output. Перевірити справедливість при backlog, missing credentials, waiting_dependency та відсутність automatic retry terminal failed stage. Test: tests/launch-recovery-dispatch.test.ts.
14. **Preview/source race.** Не змінюючи Launch version, перейменувати використаний Buyer/соц після preview. Generate → SOURCE_CHANGED, нуль side effects; explicit source refresh і нове підтвердження дають актуальний result. Accepted request replay зберігає первісний intent. Unknown Drive version не дає reuse без перевірки.
15. **Copy timezone/replay.** Source створений в іншому поясі. Copy у поточному browser timezone біля півночі/DST; retry наступного дня повертає той самий ID/date. Changed timezone на тому самому key → conflict.
16. **Browser privacy.** Synthetic URL token/ручний секрет: input→conflict→copy→reload/logout. localStorage/sessionStorage/IndexedDB/Cache API/operation journal і service-worker cache protected detail не містять значень; unsaved RAM очищується, saved detail доступний тільки через ACL.
17. **Manual mismatch.** Ручна зміна URL → catalog warning, зміна budget/range/SUB → відповідна dependent hint. Save/reopen лишає підказки; reset відповідного override прибирає. Жодного catalog update/rename.
18. **Restore history.** Відкрити стару revision→«Відновити конфігурацію», перевірити dirty save/discard/cancel, стару дату, config budgets, відсутність result overrides і незмінну metadata. Removed source блокує Generate, explicit refresh оновлює preview; viewer/active lock/conflict відмовляє. Лише explicit Generate публікує нову revision, старий каталог/результат зберігаються.
