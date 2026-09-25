# Phase 0 Research: Надійна синхронізація та завантаження вкладених папок

## R1. Одна постійна робота та кінцеві обходи

**Decision**: На кожне активне підключення існує рівно одна довгоживуча `incremental` робота, яка володіє change cursor. Первинний, ручний і автоматично відкритий обхід піддерева є кінцевими `subtree` роботами з власною областю та terminal state. Вони читають початковий cursor для catch-up, але не записують cursor підключення.

**Rationale**: Поточний RPC ручного обходу створював ще одну роботу, яка після дерева переходила в `incremental`. Так накопичувались регулярні роботи одного підключення, витрачали слоти й спроби. Розділення ownership прибирає гонку курсорів і дає точний статус кнопці.

**Alternatives considered**:

- Один тип job із прапорцем у cursor: надто легко випадково знову перетворити finite роботу на постійну.
- Повна синхронізація для кожного ручного кліку: дорого й не відповідає області відкритої папки.
- Лише автоматичний changes feed: не гарантує нащадків папки, яку перенесли вже заповненою, і не дає ручного способу відновлення довіри.

## R2. Безпечне точне звіряння папки

**Decision**: Seen staging має ключ `(job, generation, parent_folder_id, drive_file_id)`. Після повної пагінації без incompleteSearch/malformed entries створюються кандидати на missing. Їх актуальні parent/trash перевіряються у Drive; ambiguous 403/404 означає unavailable. Commit перевіряє connection lease epoch і baseline catalog mutation; finite completion чекає canonical replay barrier. Rejected page token починає нову generation. Durable frontier не обрізає широке дерево після 10 000 папок.

**Rationale**: Простий upsert додає й оновлює записи, але не доводить видалення. Порівняння лише останньої сторінки небезпечне. Durable staging переживає yield/restart і дозволяє довести повний direct-child snapshot без тримання 50k ids у пам’яті/job JSON.

**Alternatives considered**:

- Масив усіх ids у job cursor: росте без межі, часто переписується, погано відновлюється.
- Tombstone всього, чого немає на поточній сторінці: видаляє записи з наступних сторінок.
- Ніколи не reconciliate deletions: залишає фантомні файли після ручного обходу.

## R3. Нова заповнена папка у потоці змін

**Decision**: Коли changes feed upsert-ить папку, яка нова для каталогу, повернулась із `missing`, змінила батька з-за меж області або ще не має підтвердженої повноти, він idempotently enqueue-ить finite subtree scan цього folder id. Власне change event не намагається перелічити нащадків.

**Rationale**: Provider повідомляє зміну папки, але її старі нащадки можуть не мати нових change records. Окремий кінцевий обхід покриває moved-in populated folder і використовує той самий механізм повноти, що первинне сканування.

**Alternatives considered**:

- Сподіватися на окремі events усіх нащадків: не гарантується для вже наявного дерева.
- Рекурсивно читати дерево всередині одного change page: перевищує lease/time budget і заважає cursor progression.

## R4. Черга, пріоритет і retry semantics

**Decision**: Claim order використовує класи `user_subtree`, `discovered_subtree`, `initial`, `incremental`, але weighted fairness резервує обслуговування готової background роботи не рідше визначеної межі. `attempts` рахує лише послідовні невдалі claims з error; успішний checkpoint/complete скидає failure count. Окремо зберігається `run_count` для діагностики. Stale watchdog переводить роботу в явний стан.

**Rationale**: Простий абсолютний пріоритет вирішує ручний клік, але може голодувати інші простори. Поточний attempts збільшувався на кожному нормальному claim і міг досягти аварійної стелі без помилки.

**Alternatives considered**:

- FIFO: регулярні poller-и можуть затримувати ручну роботу.
- Нескінченний пріоритет user work: шкодить фоновій актуальності під навантаженням.
- Прибрати retry ceiling: приховує постійні помилки й створює безмежні витрати.

## R5. Доставка змін усім учасникам

**Decision**: Workspace Realtime використовує дозволені `team_catalog_events` і `team_operations`. Події invalidation містять old/new parent scope. Subscribe/reconnect/visibility перечитують authoritative visible snapshots; event-during-read встановлює dirty flag. IDs не є contiguous cursor або commit watermark; event replay API немає. Loaded-window anchor, selection, sort і search зберігаються. Membership loss очищує кеш.

**Governance (T002)**: Після явного запиту про agent SSE / team Supabase Realtime користувач відповів «продовжи». Через окремий constitution workflow Principle VI уточнено у [конституції 3.0.1](../../.specify/memory/constitution.md): агент використовує SSE, командний каталог — чинний Supabase Realtime seam із membership/RLS та одним subscribe/reconnect шляхом. Новий recurring polling і серверні відсотки заборонені. Це working-tree amendment; merge/ratification не заявляється. Gate для implementation вирішено.

**Rationale**: Перевірена beta мала дані в каталозі, але відкритий список не оновився. Чинний hook також заявляє підписки на таблиці, яких немає в Realtime publication. Подія є сигналом перечитати авторитетний каталог, а не другим джерелом матеріалу.

**Alternatives considered**:

- Публікувати `team_materials`: ширший payload, більший security/volume surface і складніший cache patching.
- Постійно poll-ити всі папки: витрати множаться на учасників і суперечать єдиному live-state seam.
- Refresh усіх teams і повного дерева на кожен event: функціонально просто, але дорого на великому каталозі.

## R6. Маніфест локальної папки

**Decision**: У web формується discriminated manifest entry: `file` з `File`, relative path і size або `directory` з relative path. Adapters покривають file input, directory handle та dropped directory entries. Directory entries додаються до обходу до читання дітей, тому порожні папки зберігаються. Шляхи нормалізуються як POSIX relative paths, забороняють absolute/`..`/NUL і мають ліміти depth/count/length.

**Rationale**: Поточний `UploadFile[]` містить тільки файли; порожня папка не може з’явитись. Розділення enumeration від upload дозволяє показати “Підготовка”, зафіксувати destination, знайти errors і однаково обробити picker/drop.

**Alternatives considered**:

- Визначати папки лише з `file.webkitRelativePath`: втрачає порожні каталоги.
- Відправляти абсолютні локальні шляхи на сервер: зайве розкриття приватних даних і не працює у звичайному browser flow.
- Архівувати все в один ZIP: змінює користувацькі файли й не відповідає структурі Drive.

## R7. Одна кнопка “Додати файли”

**Decision**: Одна toolbar action відкриває доступне меню з “Файли” і “Папка” там, де системний chooser не може одночасно вибрати обидва типи. Це один user flow; окрема постійна кнопка папки видаляється. Drag-and-drop приймає змішані корені напряму.

**Rationale**: Browser/OS picker capabilities відрізняються. Обіцянка одного системного діалогу для одночасного file+folder selection ненадійна; одна дія з двома режимами відповідає спеці й доступності.

**Alternatives considered**:

- Прихований `webkitdirectory` на звичайному file input: режим каталогу не є універсальним і не зберігає порожні папки.
- Дві toolbar buttons: прямо суперечить цільовому UX.

## R8. Стійка група операцій

**Decision**: Один WorkspaceOperationsProvider тримає локальні групи. Actor/team-scoped IndexedDB записує тільки accepted/item-state checkpoints: relative metadata, operation/idempotency IDs, results і attempt. Byte progress, File, handles, secrets і signed URLs не зберігаються. Жодних server groups/items, percentage RPC/writes/publications/polling/telemetry. Terminal7d/interrupted30d, sign-out purge, quota failure=session-only; local ownership lease захищає від двох вкладок.

**Rationale**: Один toast per file створює шум, а пам’ять React не переживає reload. Локальні checkpoints дають обмежене відновлення без додаткового cloud I/O; команда бачить готові матеріали. Creative Library batch має іншу доменну семантику.

**Alternatives considered**:

- Лише пам’ять вкладки: не дає reload recovery; додаємо локальні metadata checkpoints. Командна видимість відсотків не є вимогою.
- Розширити `team_upload_batches`: зайві library fields (`stage`, offer, geo/language) та несумісний lifecycle.
- Створити нову файлову mutation систему: дублює authority/idempotency чинних `team_operations`.

## R9. Семантика прогресу

**Decision**: Operation stage є явним: `preparing`, `creating_folders`, `transferring`, `moving`, `updating_catalog`. Denominator: confirmed bytes або terminal items; невідомий обсяг indeterminate. Callback оновлює локальний тост без cloud I/O і journal writes. 100% stage не стає succeeded до catalog postcondition. Зміна attempt явно починає новий denominator.

**Rationale**: Ресурсний прогрес вже доступний у resumable upload callback. Таймерний відсоток бреше. Окремий stage дозволяє чесно показати “Оновлення простору” після останнього byte.

**Alternatives considered**:

- Однакова вага кожного файла: маленький і багатогігабайтний файл спотворюють відсоток.
- Уявний повільно зростаючий progress для provider move: не пов’язаний з підтвердженою роботою.
- Оголосити успіх після network upload: файл ще може не бути видимим у каталозі.

## R10. Toast та Activity summary

**Decision**: Розширити чинний ToastProvider stageLabel/detail/progress; максимум три тости, решта власних груп у локальному summary. Чужі відсотки не передаються. Accessibility announcement робиться на stage і значущих кроках, не кожному percent.

**Rationale**: Компонент уже підтримує `push/update/dismiss` і determinate bar. Один provider стоїть над team surfaces, тож операція переживає закриття діалогу. Persistent operation, а не toast, є source of truth.

**Alternatives considered**:

- Новий progress notification component: порушує inventory/state discipline.
- Один toast на item: перекриває екран і створює шум для screen reader.

## R11. Відновлення і cancel

**Decision**: Після reload спочатку звіряємо existing material operation IDs, включно з lost finalize response. Succeeded не повторюємо. Незавершені uploads потребують reselection і явного підтвердження: нова attempt починається з byte0 навіть за збігу path/size. Cancel зупиняє scheduling/active requests без rollback підтверджених результатів. Без local checkpoint історія не обіцяється.

**Rationale**: Browser не має права мовчки зберігати довічний доступ до локальних файлів. Частковий результат є реальністю remote mutations; rollback може бути небезпечнішим за явний partial state.

**Alternatives considered**:

- Обіцяти автоматичний resume після reload: часто неможливо без нового дозволу.
- Видаляти вже завантажені файли при cancel: деструктивно й може конфліктувати з наступними змінами.

## R12. Межі Google scope

**Decision**: План не змінює OAuth scope. Sync engine працює з фактично доступними об’єктами, зберігає coverage/permission failure окремо від empty, а UX чесно показує partial access. Повнота перевіряється на контрольному дереві, яке відоме як доступне поточному підключенню.

**Rationale**: У відтвореному випадку Google уже повернув папку й файл; проблема була у видимості UI. Приписувати її scope без доказу було б хибно. Окрема brand/OAuth verification feature може змінити scope незалежно.

**Alternatives considered**:

- Вимагати restricted scope як частину цієї фічі: розширює юридичний і release scope та не виправляє локальні sync/UI дефекти.

## R13. Runtime and rollout ownership (T003)

Active path: catalog-sync/index.ts parses the service_claim_catalog_sync_jobs
projection, builds Drive/RPC dependencies and calls engine.ts runCatalogSyncJob.
worker.ts is a helper, not the scheduler. Current writes use unfenced
service_upsert_catalog_page/service_tombstone_catalog_files, while only progress
and completion check the worker lease. The new authority must fence catalog
writes as well as checkpoints.

The uncommitted 20260922190000 migration makes requested_folder_id scans finite;
it does not establish singleton ownership or protect catalog writes. Later
chronological migrations own backfill and new contracts. Connection cursor
provenance is authoritative only when confirmed; ambiguous historical jobs
require bounded reconciliation, never lexicographic or numeric token selection.
Old workers must be fenced/drained before new job kinds are enabled.

Move entry points: useExplorerClipboard.ts, ExplorerShell.tsx tree drop,
MaterialActionHost.tsx → actions.move; material tail helper is
materials/tail.ts moveMaterialWithTail. All must enter the local coordinator.
Existing ignore files cover Node builds, secrets, caches and test outputs;
package.json is private and no Docker/Terraform/Helm inputs were found.

## Resolved unknowns

### Implementation evidence: ownership and snapshot boundaries (2026-09-24)

`20260924100000_catalog_sync_ownership.sql` separates finite work from one canonical
feed owner, serializes leases per connection, and supplies explicit epochs to the
active worker's lifecycle RPCs. Legacy acquisition/checkpoint grants are retired.
An unknown historical cursor cancels old leases, preserves materials, captures a
fresh start token before scanning, and confirms provenance only on canonical replay.
Finite listing waits for the next canonical replay sequence. Claims are diagnostic
`run_count`; retries consume `attempts`; health follows `last_progress_at`, not claims.

The T007 baseline uses PostgreSQL transaction visibility (`pg_snapshot` plus a
trigger-stamped full transaction ID on each material), not a maximum sequence or
provider timestamp. The upsert checks the locked conflict row against the saved
snapshot, protecting concurrent insert/update commits. Candidate reconciliation
also compares the exact observed mutation ID after the provider read. Seen entries,
child frontier rows, catalog writes and pagination checkpoints share a transaction.
These SQL seams are foundation work; the active worker's durable-frontier adoption
and fencing of its remaining legacy catalog writes belong to T012–T013.

The public types command currently hardcodes `--linked`. For local unshipped
migrations, use the same Supabase generator with `--db-url` targeting an isolated
schema copy instead; do not apply development migrations to production just to
generate types. Preserve the custom aliases and unrelated working-tree edits in
`database.types.ts` when merging the generator's affected definitions.

T002 transport scope уточнено у конституції 3.0.1; решта меж визначена планом і R1–R12.
