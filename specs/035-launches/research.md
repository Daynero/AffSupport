# Research — Launches

Джерело: локальний код і [spec.md](spec.md), включно з уточненнями користувача. Дослідження не перевіряло production, реальний AIO або імпорт у Meta. Рішення нижче визначають план; робочі defaults не видаються за окреме погодження власника.

## R1. РК і зв'язок із соцом

**Decision:** FK на team_account_agents.id із team_id; current join до team_accounts, immutable snapshots при генерації. Окремий BM не вводити. ID РК — textual digits >=3, suffix slice(-3).

**Evidence:** packages/shared/src/team/accounts.ts; apps/web/src/team/accounts/useAccounts.ts; finance placement/rehome migrations. Наявний ID validator ширший за числовий.

**Rationale:** отримуємо реальну ідентичність і не втрачаємо історичну назву після перенесення. **Alternatives:** парсити тег або зв'язувати за suffix — колізії; створити довідник РК — дублювання.

## R2. Єдиний pure module для браузера й Edge

**Decision:** packages/shared/src/team/launches.ts + розбиті pure helpers; Edge imports compiled `../../../packages/shared/dist/team/launches.js`, web — shared export barrel. Будувати shared перед перевіркою Edge bundle.

**Evidence:** supabase/functions/team-invitations/handler.ts, drive-transfer/handler.ts, _shared/errors.ts уже імпортують shared/dist. Package main — dist/types.js, тому потрібний export з чинного entry chain.

**Alternatives:** копії generator на Edge та web — drift; remote library — зайва залежність. Bundle smoke з новим import потрібен під час implementation, не зроблений зараз.

## R3. URL — буквальне збереження

**Decision:** дослівний original; raw query segments; змінюються тільки values буквальних case-sensitive sub1/sub2/sub3. Дублікати лишаються, усі керовані values однакові. Encoded keys/інші регістри незмінні. Empty builder preserve; active missing SUB append перед fragment. Невалідний URL не виправляється мовчки.

**Rationale:** останнє пряме уточнення користувача. **Alternatives:** URLSearchParams serialize/canonicalization, trim, dedup — міняють сторонні байти. Раніший AC-12 був застарілим і синхронізований із цим рішенням.

**External boundary:** вибрано literal keys за вимогою; це не доказ, що сторонній tracker приймає кожний підписаний URL після зміни SUB. Production fixture потрібен з усіма ключами/макросами й синтетичними значеннями. До цього не заявляти сумісність із підписаними query.

## R4. SUB text і display overrides

**Decision:** єдиний normalizer/validator для змінних, ASCII letters/digits/_/-, spaces→_; Buyer і alias required, social/suffix при включенні в builder. Без автотранслітерації. Display override не стає input наступного generator. У UI назва поля «URL».

**Rationale:** погоджено користувачем. **Alternatives:** окремий slug або закодована кирилиця для creative — відхилені користувачем. Чужі параметри original не перевіряються за ASCII SUB правилом.

## R5. Матеріали та catalog link

**Decision:** material picker/upload reuse, one material; video для catalog, video/image для other. Папка upload — existing Task attachments через нейтральний adapter. Catalog URL — готовий `sheetUrl=webViewLink` Google Drive. ProductCount default 100, 1–400.

**Evidence:** TaskAttachmentPicker.tsx accept/onAdd, TaskEditor.tsx uploadTeamFile; task-drop-folder.ts appProperties marker; CreateProductCatalogDialog.tsx; product-catalog.ts video-only check/Drive conversion; product-catalog/limits.ts.

**Alternatives:** нова file store, image catalog pipeline, окремий URL endpoint — не потрібні для v1.

## R6. Replay та variant allocation

**Decision:** reserve variant під lock на logical catalog operation; persist request digest/result reference. Replay до будь-яких side effects. Persist random rows/resources для відновлення тієї самої спроби.

**Evidence:** product-catalog.ts nextVariant перед startOperation, reused lookup за свіжим variant; service_next_product_catalog_variant SQL — MAX+1. Наявний механізм не дає потрібної гарантії replay.

**Alternatives:** disabled button, новий UUID при retry, lookup latest catalog — не захищають від двох вкладок/втраченої відповіді.

## R7. Progress і транспорт

**Decision:** local agent SSE через useAgentEventStream; hosted invalidation через Supabase Realtime, initial/reconnect/foreground authoritative read. Один subscription owner. Generation stages persisted. Відсоток тільки там, де є виміряний completed/total; решта — названий етап без оцінки.

**Evidence:** useTeamOperation.ts уже має read + Realtime + SSE; ProductCatalogProgress.tsx — timers; drive-ops/index.ts catalog markRunning hardcodes uploading/30; OperationStatus.tsx завжди показує % і потребує indeterminate mode.

**Alternatives:** новий poll loop або таймерна анімація як «точний прогрес» — суперечать constitution/вимогам.

## R8. Cancel, recovery, sharing

**Decision:** parent generation fencing + cancel checkpoints у catalog. Finalize material ≠ registered catalog. Drive create marker + persisted intent/output ID, reconcile uncertain outcomes перед retry. `cancel_requested` і `canceled_with_cleanup_pending` — окремі parent states; `canceled` лише після settlement. UI inputs locked до settled cancel; failed/interrupted дозволяє явний resume/cancel, не нову конкурентну generation.

**Evidence:** cancel_team_operation revokes grants і locks state, але product-catalog handler не перевіряє cancel між external calls; finalize йде до link. Drive client має appProperties support, який можна розширити для operation marker lookup.

**Side effect:** anyone-reader permission додається на оригінал/зображення до готового каталогу. План має журналювати permission ID/попередній стан, доданий саме цією generation, і знімати лише такий permission за відсутності інших references/concurrent usage. Якщо неможливо довести безпечне повернення доступу, лишити cleanup_pending із поясненням, а не видаляти спільний доступ. «Як нічого не було» означає відсутність нового активного result і безпечний rollback доведених власних side effects; абсолютна зовнішня транзакція не обіцяється.

**Alternatives:** blind trash/stop UI тільки, повторити POST після timeout — можуть втратити/подвоїти ресурс.

## R9. Права й секрети

**Decision:** закриті raw config/revision tables; narrow RPC і окремі safe projections; immutable results, без URL у Realtime/list/audit/client persistence. Archive не видаляє material, попередження враховує каталоги всіх revisions; preference персональна team/user і комітиться з archive.

**Evidence:** чинні column grants accounts, typed team API, catalog settings/sourceLink persistence. Encryption-at-rest політику хостингу не підміняти новою саморобною криптографією.

**Open external release gate:** посилання на таблицю погоджене, але це не окреме погодження публічного CAPI token. Чинний catalog anyone-reader робить sourceLink доступним читачам таблиці. Перед production прийманням потрібне рішення власника щодо таких URL. Можна реалізувати й перевірити весь pipeline на синтетичному URL без секретів; секрет не вилучати й URL не переписувати автоматично. Gate блокує shipping сценарію з непогодженим розкриттям, а не створення плану.

## R10. Робочі параметри дизайну

**Decision:** naming marker ` adv+` після age; campaignCount<=100/maxBudget<=999999/adsCount<=1000; manual budgets strictly increasing і last=max; dictionary duplicate key NFC+trim+case-insensitive; permissions із spec; retention archive без purge. Це робочі пропозиції, які можна змінити до реалізації без перестворення архітектури.

**Rationale:** достатньо для deterministic contracts/оцінки, без нових бізнес-сутностей. Числа не є лімітами Meta. **Alternatives:** залишити технічні contracts невизначеними — ускладнює tasks; оголосити рішення вже погодженими — не відповідає фактам.

## Підсумок research gates

Технічні seams і дизайн визначені. External gates: signed URL compatibility, public sourceLink policy, фактична provider recovery behavior під fault injection. Вони мають перевірки й safe outcomes; їх не маскувати як успішно доведені властивості. Жоден новий catalog executable не вводиться до закриття M4 recovery gate.
