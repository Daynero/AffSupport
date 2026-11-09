# Tasks: Опційна публікація відео каталогу в R2

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contract](./contracts/catalog-video-r2.md), [quickstart](./quickstart.md). Оновлено після аналізу 2026-11-09 (C1, H1–H3, M1–M7, L1–L4 внесені).

**Tests**: обов'язкові (acceptance + 031), як у 045. Важкі перевірки послідовні: перед запуском `uptime`, vitest лише `--pool=forks --poolOptions.forks.singleFork=true`, один worker; `npm run verify` — лише фінальний гейт, коли машина вільна. Ніколи `db reset` на беті; міграції — `psql` + запис у `schema_migrations` (migration up заблоковано чужою версією). Міграція: `supabase/migrations/20261207191000_catalog_video_r2.sql`. Зміни в `packages/shared` означають повний реліз (R13) — web-only деплой заборонений.

**Format**: `[ID] [P?] [Story] Опис зі шляхом`. [P] — незалежні файли без незавершених залежностей.

## Phase 1: Setup

- [ ] T001 Зафіксувати у `specs/050-catalog-video-r2/validation.md` стан робочої копії, резервацію слота міграції `20261207191000`, перелік environment-входів (bucket staging/public для відео, домен, zone/purge token, `CATALOG_VIDEO_R2_*`; секрет воркера — чинний `wishly_catalog_sync_secret`, нових секретів немає), залежність від увімкненого R2-конфігу 045 та рішення про повний реліз (R13); не запускати provisioning у production.
- [ ] T002 Додати розділ «Public catalog video exception (050)» у `docs/NO_SERVER_MEDIA_PLAN.md` (межі: лише відео каталогу за явною опцією, лише активна версія, непрозорий публічний URL, видалення при заміні, надгробки при видаленні простору) і створити `docs/CATALOG_VIDEO_R2.md` з bucket/домен/CORS/Range/purge/квотами/environment-ізоляцією/cron. FR-018; SC-008.
- [ ] T003 Закріпити залежності підпису/multipart для Deno у `supabase/functions/catalog-video-r2/deno.json` (ті самі версії, що в `catalog-images/deno.json`), додати `[functions.catalog-video-r2] verify_jwt=false` у `supabase/config.toml` з явним розрізненням user-JWT та заголовка `x-catalog-sync-secret` (чинний секрет catalog-sync, як у 045) для cron; довести на пісочниці multipart create/upload-part/complete/abort і **поведінку `x-amz-checksum-sha256` на `UploadPart`** (чи відхиляє R2 невідповідну суму); результат записати у `validation.md` — від нього залежить `verified_by` у T009/T013. FR-004/014.

## Phase 2: Foundation (блокує історії)

- [ ] T004 [P] Написати тести контрактів і guards у `tests/catalog-video-r2-contract.test.ts`: стани копії, закриті коди, discriminated результати, відхилення невалідних входів (`unknown` → union), `LaunchCatalogConfig.copyVideoToR2` необов'язкове і за замовчуванням `false`. FR-001/004; AD-003.
- [ ] T005 Реалізувати типи, стани, коди, ліміти й guards у `packages/shared/src/team/catalog-video-r2.ts`, експорти в `packages/shared/src/team/index.ts` та `packages/shared/src/index.ts`; нові TeamErrorCode у `packages/shared/src/team/transport.ts`; поле `copyVideoToR2?: boolean` у `LaunchCatalogConfig` (`packages/shared/src/team/launches.ts`) і його валідація в `packages/shared/src/team/launches/validation.ts`; exhaustive мапінг у `supabase/functions/_shared/errors.ts` та `apps/web/src/team/errors.ts`; зібрати shared і пройти T004. Протокол агента (`release.ts`, `AGENT_API_VERSION`) не змінюється.
- [ ] T006 [P] Написати SQL-тести ізоляції/ідемпотентності/квоти/lease/fence/переходів у `supabase/tests/database/catalog-video-r2.test.sql` і `tests/catalog-video-r2-schema.test.ts`: anon/view-only/чужий тенант/service-only, унікальність `(team_id, source_version)`, перевищення квоти, stale fence, `retiring→ready` при новому use, відсутність запису опції = вимкнено, **надгробок переживає каскад видалення простору**, `cron.schedule` зареєстровано для `claim` і `sweep`, інвокатор читає чинні vault-записи `wishly_catalog_sync_*`, формує endpoint `/catalog-video-r2/worker` і не розкриває секрет, `confirm_use` замінює весь набір uses (зайві джерела й `link_kind='drive'` звільняють копії).
- [ ] T007 Створити міграцію `supabase/migrations/20261207191000_catalog_video_r2.sql`: `catalog_video_r2_config` (з `policy_confirmed_at`), `_preferences` (last-write-wins), `_copies` (з `source_md5`, `full_hash_verified`, тригер `before delete` → надгробок), `_parts` (з `verified_by`), `_uses` з PK `(catalog_material_id, source_material_id)`, `_purges` без FK, `_journal` (з `actor_id` для `configured`, `part_verification`); RLS + `revoke all`; security-definer RPC (`set_preference` з перевіркою `private.can(p_team,'manage_metadata',auth.uid())` як у `set_team_product_catalog_settings`, `get_state`, `reserve_copy` з атомарною квотою, `claim/renew/complete_part`, `mark_ready`, `confirm_use` **set-replace** за контрактом, `retire_orphans`, `begin_retire`, `claim_retire`, `mark_deleted`, `claim_purge`, `mark_purged`); `link_kind` у квитанції публікації посилань; `private.invoke_catalog_video_r2_worker(route)` дослівно за зразком `invoke_catalog_images_worker` (vault `wishly_catalog_sync_url`/`wishly_catalog_sync_secret`, `regexp_replace` на `/catalog-video-r2/worker`, заголовок `x-catalog-sync-secret`) і `cron.schedule` для `claim` (30 с) та `sweep` (5 хв); регенерувати `apps/web/src/lib/database.types.ts` (`npm run types:supabase`); пройти T006. Додати запис у `supabase/migrations/ROLLBACK.md`.
- [ ] T008 [P] Написати тести адаптера в `tests/catalog-video-r2-adapter.test.ts`: multipart create/part/complete/abort, обидва способи перевірки частини (`provider_checksum` через заголовок і `readback` через Range + власна SHA-256) з невідповідністю → `CHECKSUM_MISMATCH`, HEAD, Range-проби, повний MD5 за можливості, видалення, purge, очищені помилки (жодних ключів/URL/credential у помилках), провайдер-ін'єкція.
- [ ] T009 Реалізувати S3-адаптер `supabase/functions/_shared/r2-catalog-video.ts` за зразком `r2-catalog-images.ts` (`readCatalogVideoR2Config` з перевіркою target-confirmation, відмова для `.r2.dev`/`*.r2.cloudflarestorage.com`; create-only complete; per-part SHA-256 із двома стратегіями підтвердження за результатом T003; verify; remove; purge); пройти T008.
- [ ] T010 [P] Написати тести резолвера у `tests/catalog-video-link-resolver.test.ts`: без опції — результат байт-у-байт як до фічі (включно з `ensureAnyoneReader`), опція + ready → R2 без публікації Drive-файлу, опція без копії → Drive + ідемпотентний enqueue, збій R2 ніколи не кидає, повертається базовий URL і `catalogVideoVariation(url, mark)` працює над ним. SC-001; FR-006/019.
- [ ] T011 Реалізувати єдиний резолвер `supabase/functions/_shared/catalog-video-link.ts`; пройти T010.

## Phase 3: US1 — Увімкнути R2 при створенні каталогу (P1) 🎯 MVP

**Independent test**: quickstart #1–3, #11: два каталоги з однаковими джерелами, з опцією й без (у т.ч. через Launch); перший читається анонімно з R2, другий незмінний; без права — відмова.

- [ ] T012 [P] [US1] Написати тести воркера в `tests/catalog-video-r2-worker.test.ts`: claim/lease, суцільні частини, обрив і продовження з наступної частини, abort при термінальній невдачі, зміна джерела під час копіювання → `SOURCE_CHANGED`, невідомий результат PUT → узгодження без дублю, перевірка розміру/HEAD/Range-проб, `verified_by` кожної частини записано, повний MD5 коли файл уміщається в один invocation і `full_hash_verified` інакше `false`, `ready` лише після публічного підтвердження. FR-004/007/014.
- [ ] T013 [US1] Реалізувати воркер `supabase/functions/catalog-video-r2/worker.ts`: потік Drive range → UploadPart, per-part SHA-256 у БД з `verified_by` (стратегія за T003), дедлайн-обмежене число частин за invocation, verify (розмір, HEAD, проби, повний MD5 за можливості), `mark_ready`; маршрути `claim`/`sweep` за тілом `{"route"}` від інвокатора; пройти T012.
- [ ] T014 [US1] Реалізувати `supabase/functions/catalog-video-r2/index.ts` і `handler.ts`: `GET /availability` (`DISABLED`/`NOT_CONFIGURED`/`POLICY_PENDING`), `GET /catalogs/:id/state` (з `lastSuccessfulUpdateAt`, `copy.fullHashVerified`), `PUT /catalogs/:id/preference` (`{enabled}`, last-write-wins, `authorizeCaller` + RPC із `private.can(p_team,'manage_metadata',auth.uid())`, журнал `configured` з `actor_id`), `POST /worker` лише з чинним `x-catalog-sync-secret` (як `catalog-images`), route `claim`/`sweep` із тіла; анонімні/browser-виклики воркера відхиляються. FR-003/013/016.
- [ ] T015 [P] [US1] Написати тести приймання опції при створенні в `tests/catalog-video-r2-create.test.ts`: поле `copyVideoToR2` у create-запиті (`drive-ops product-catalog`, `catalog-durable`) та в `LaunchCatalogConfig` (`launch-catalog`) застосовується в тій транзакції, що прив'язує матеріал; відсутнє поле = вимкнено; старий клієнт; повтор того самого intent не дублює. FR-001/002/019.
- [ ] T016 [US1] Додати `copyVideoToR2` у durable create intent і застосування в `supabase/functions/drive-ops/product-catalog.ts`, `drive-ops/catalog-durable.ts`, `supabase/functions/_shared/product-catalog.ts`; у `drive-ops/launch-catalog.ts` — читання `copyVideoToR2` із `settings_snapshot` конфігурації каталогу запуску; пройти T015.
- [ ] T017 [US1] Підключити резолвер замість прямого `videoShareLink` у `supabase/functions/catalog-updater/publication-io.ts`, `drive-ops/updater-variants.ts`, `drive-ops/catalog-initial-video-authority.ts`, `drive-ops/catalog-durable.ts`; `link_kind` у квитанції, перехід лише на межі нового job (recipe не перепробовується), порівняння `old.url` над базовим URL того самого `link_kind`, варіація `#mark` накладається після резолвера; регресії наявних тестів `tests/catalog-updater-worker.test.ts`, `tests/launch-catalog-video-execution.test.ts`. FR-004/006; SC-001.
- [ ] T018 [P] [US1] Написати тести UI в `tests/catalog-video-r2-ui.test.tsx`: галочка в усіх місцях створення з однаковим змістом (діалог створення, меню каталогу, конфігурація каталогу запуску), вимкнена за замовчуванням, прихована при `available=false`, disabled без права, статус-чип R2/Drive/причина + час останнього успішного оновлення, **увімкнення при створенні — рівно один клік (SC-005)**.
- [ ] T019 [US1] Додати типізовані виклики `apps/web/src/api/team-catalog-video-r2.ts` та делегування в `apps/web/src/api/team.ts` (без другого глобального клієнта).
- [ ] T020 [US1] Реалізувати `apps/web/src/team/product-catalog/CatalogVideoR2Toggle.tsx` з компонентів інвентарю `components/ui/` і токенів (жодних сирих значень; перевірити `scripts/check-design-tokens.mjs`, `check-tailwind-classes.mjs`); підключити в `CreateProductCatalogDialog.tsx` і `ProductCatalogMenuDialog.tsx`; пройти T018 (частина створення).
- [ ] T021 [US1] Додати опцію в конфігурацію каталогу запуску: значення за замовчуванням `false` у `apps/web/src/team/launches/launchCatalogDefaults.ts`, галочка (той самий `CatalogVideoR2Toggle`) у `LaunchSession.tsx` і відображення в `LaunchDefaultsReview.tsx`/`LaunchChangeReview.tsx`, передача в `restitch-runner.ts`; пройти T018 (частина Launch). FR-002.
- [ ] T022 [P] [US1] Додати uk/en локалі пояснення («що копіюється», «лише активна версія», «публічно за непрозорим посиланням»), статусів і причин у `apps/web/src/locales/uk.ts` та `en.ts`; узгодити з кодами з контракту; термінологія: «опція R2» для налаштування каталогу, «доступність фічі» для гейта.

## Phase 4: US2 — Увімкнути або вимкнути для наявного каталогу (P1)

**Independent test**: quickstart #4, #5, #10: Drive→R2 при наступному оновленні, повторне оновлення без дубля, вимкнення повертає Drive.

- [ ] T023 [P] [US2] Написати тести переходів у `tests/catalog-video-r2-transition.test.ts` та SQL-кейси в `supabase/tests/database/catalog-video-r2.test.sql`: зміна опції не змінює посилання до оновлення; оновлення без нового відео копіює наявне; повтор не створює другу копію; R2→Drive на наступному оновленні; одночасні зміни — остання збережена виграє без конфлікту, автор і час зафіксовані; збій копіювання лишає працездатне посилання. FR-003/005/006/011.
- [ ] T024 [US2] Реалізувати постановку копіювання для наявного каталогу й межу переходу в `supabase/functions/catalog-updater/worker.ts`, `catalog-updater/index.ts`, `catalog-updater/publication-authority.ts`: enqueue ідемпотентний, повторне оновлення читає готову копію, зворотний перехід на Drive проходить повний шлях `ensureAnyoneReader`; пройти T023.
- [ ] T025 [US2] Додати галочку й статус у налаштування автооновлення менеджера: `apps/web/src/team/product-catalog/ProductCatalogSettingsSection.tsx`, `ProductCatalogMenuDialog.tsx`, `useCatalogSettingsFlow.ts`; реєстрація безпечної інвалідації в `apps/web/src/team/useTeamRealtime.ts` без нового polling; розширити `tests/catalog-video-r2-ui.test.tsx` (**для наявного каталогу — не більше двох кліків, SC-005**).

## Phase 5: US3 — Лише активна версія (P1)

**Independent test**: quickstart #6, #8, #9, #13–#15: кілька оновлень лишають одну активну версію на відео-джерело; частковий cleanup завершується; спільна копія живе, поки є use; видалення простору не лишає об'єктів; кошик/зняття з автооновлення/пауза копій не чіпають.

- [ ] T026 [P] [US3] Написати тести життєвого циклу в `tests/catalog-video-r2-retention.test.ts` і SQL: перехід use на нову копію (ключ `(catalog_material_id, source_material_id)`), **set-replace** у `confirm_use` (джерело прибране з каталогу → його копія `retiring`; підтвердження з `link_kind='drive'` → усі uses каталогу зняті), `retiring` після нульових uses, вікно, повторна перевірка нуля перед видаленням, `retiring→ready`, спільна копія кількох каталогів, остаточне видалення матеріалу каталогу → каскад uses → `retire_orphans`, кошик (`trashed_at`) і відновлення → без змін, зняття з автооновлення (видалення рядка `team_catalog_updater_items`) → без змін, пауза (`paused_by_tariff_at`, stop hold) → без змін, видалення простору → надгробки → об'єкти прибрано, незавершена публікація тримає recipe, не видаляється активна, невідомий результат видалення, cleanup-race. FR-009–012; SC-003/004.
- [ ] T027 [US3] Реалізувати `confirm_use` (set-replace за контрактом) після підтвердженого запису каталогу у `supabase/functions/catalog-updater/worker.ts`/`publication-io.ts`, `retire_orphans`/`begin_retire`/`claim_retire`/`mark_deleted`, обробку надгробків (`claim_purge`/`mark_purged`: видалення об'єкта + purge, успіх = 404 на HEAD) і sweep (retire, abort осиротілих multipart) у міграції та `supabase/functions/catalog-video-r2/worker.ts`; пройти T026.
- [ ] T028 [US3] Довести на рівні БД, що життєвий цикл каталогу не потребує нових хуків: остаточне видалення матеріалу каталогу каскадно прибирає `uses` (FK) → `retire_orphans` у sweep; кошик, зняття з автооновлення і паузи не торкаються `uses`/`copies` (регресійні SQL-тести на наявних RPC кошика й updater-items); видалення простору покривається тригером-надгробком з T007. Жодних змін у `supabase/functions/delete-account/` і жодних вигаданих станів «скасованого каталогу». FR-012.

## Phase 6: US4 — Прозорість: стан, витрати, діагностика (P1)

**Independent test**: quickstart #7, #12: кожен відтворений збій має людське пояснення й агентний діагноз; витрати й обсяг видимі власнику.

- [ ] T029 [P] [US4] Написати тести діагностики в `tests/catalog-video-r2-diagnostics.test.ts`: журнал стадій, кореляція намір/спроба/копія/каталог, `link_kind`, `part_verification`, `full_hash_verified` і `actor_id` стадії `configured` у журналі (історія змін опції відновлюється), закриті коди повністю покриті `scripts/analytics/code-map.ts`, очищення (жодних байтів/імен/URL/секретів), пропущені/затримані події, вимкнена аналітика не блокує продукт. AD-001–007.
- [ ] T030 [US4] Додати журнал у воркері й RPC (`catalog_video_r2_journal`) та модуль `scripts/analytics/catalog-video-r2.ts`; розширити `scripts/analytics/schema.ts`, `queries.ts`, `types.ts`, `code-map.ts` так, щоб `investigate`, `inspect`, `journey`, `audit` пояснювали новий шлях і сліпі зони (публічний GET ≠ прийняття зовнішньою платформою; неповна звірка хешу — явна; біллінг без провайдерних доказів = estimate); CLI лишається read-only; пройти T029. Оновити `docs/ANALYTICS_CLI.md`.
- [ ] T031 [P] [US4] Написати тести квоти/витрат у `tests/catalog-video-r2-quota.test.ts`: `QUOTA_EXCEEDED` залишає каталог на Drive з поясненням; оцінка вартості позначена як estimate, діапазон за недоступного обліку; обсяг на простір показується власнику. FR-015/016; SC-007.
- [ ] T032 [US4] Реалізувати відображення обсягу R2-відео простору й оцінки місячної вартості в `apps/web/src/team/tariffs/SpaceTariffSection.tsx` (блок поруч із тарифом простору) та причин fallback простими словами в `CatalogVideoR2Toggle.tsx`; оцінка — з моделі `specs/045-catalog-r2-images/cost-model.py` з розміром відео 100 МБ; пройти T031.

## Phase 7: US5 — Політика й умови (P2)

**Independent test**: політика, умови й пояснення біля галочки збігаються за змістом; до підтвердження політики `availability` повертає `POLICY_PENDING`.

- [ ] T033 [P] [US5] Написати тест відповідності в `tests/catalog-video-r2-policy.test.ts`: тексти uk/en у `apps/web/src/pages/legal-content.ts` містять виняток (відео каталогу, за явною згодою, лише активна версія, публічно за непрозорим посиланням, видаляється при заміні, прибирається при видаленні простору) і не суперечать формулюванню «медіа на сервер не завантажуються» поза винятком; `availability` повертає `POLICY_PENDING`, поки `policy_confirmed_at` порожній. FR-018; SC-008.
- [ ] T034 [US5] Оновити `apps/web/src/pages/legal-content.ts` (uk/en); реалізувати читання `policy_confirmed_at` у `supabase/functions/catalog-video-r2/handler.ts` і документувати SQL-крок підтвердження власником у `docs/CATALOG_VIDEO_R2.md`; пройти T033. Оновити відповідний розділ `docs/NO_SERVER_MEDIA_PLAN.md`.

## Phase 8: Polish та приймання

- [ ] T035 Написати провайдерну приймальну `specs/050-catalog-video-r2/provider-acceptance.ts` за зразком 045: multipart ~100 МБ, Range, анонімний GET, immutable-кеш, nosniff, видалення + purge, abort осиротілого upload; зберегти результат у `provider-result.json`.
- [ ] T036 Застосувати міграцію на беті через `psql` + запис у `schema_migrations`; задеплоїти edge-функції й web на бету; переконатися, що `pg_cron` реально викликає воркер (журнал `claim`/`sweep`); пройти quickstart #1–15 у піднятій беті (Chrome / Playwright-драйвер); зафіксувати докази у `specs/050-catalog-video-r2/validation.md`.
- [ ] T037 Повні гейти: `uptime` → `npm run verify` одним запуском; виправити знахідки; оновити `RELEASE_NOTES.md`.
- [ ] T038 Реліз за планом A→B→C→D: A — міграція + edge на прод темно; B — **повний реліз** (наступний після 1.4.0) через `run-release.sh` із панеллю watch/agent-status, shared + web + перепакований агент без зміни протоколу, бета-доказ exact-SHA, `verify-release` без обходів; C — тексти політики; D — `enabled=true`, `policy_confirmed_at=now()` для власного простору, потім для охочих. D лише після T034 і US3. Перед продом звірити, що домен/bucket/purge-токен відео налаштовані окремо від картинок.

## Dependencies & Execution Order

- Phase 1 → Phase 2 → історії. Усередині Phase 2: T004→T005; T006→T007; T008→T009; T010→T011 (T007, T009 потрібні для T011/T013).
- US1 (MVP) потребує Phase 2; T013–T014 перед T017; T016 перед T020/T021; T005 (LaunchCatalogConfig) перед T015/T016/T021.
- US2 залежить від US1 (воркер, резолвер, UI-компонент).
- US3 залежить від US1 (є що видаляти) і частково від US2 (use при оновленні); тригер-надгробок уже з T007.
- US4 може йти паралельно з US2/US3 після US1, але T030 потребує стадій воркера з T013/T027.
- US5 незалежна від коду US1–US4; T034 блокує етап D релізу.
- Polish — після всіх історій; T038 — лише повним релізом.

## Parallel Opportunities

- Phase 2: T004, T006, T008, T010 одночасно (різні файли).
- US1: T012, T015, T018 одночасно; T022 одночасно з T019–T021.
- US2: T023 незалежно від T025.
- US3/US4/US5: T026, T029, T031, T033 пишуться паралельно.
- Реалізація важких перевірок — послідовно (слабка машина, один важкий процес).

## Implementation Strategy

1. **MVP = Phase 1–3 (US1)**: опція при створенні (включно з Launch), копіювання, резолвер, fallback, cron. Достатньо для першого вмикання у власному просторі за конфігом.
2. **Далі US2** (наявні каталоги) — головна цінність для вже створеного.
3. **US3 раніше за широке вмикання**: без cleanup і надгробків витрати ростуть (SC-003/004), тому вмикати для інших лише з готовим US3.
4. **US4 і US5** — до етапу D релізу (прозорість і юридична чистота).
5. Кожен етап перевіряється на беті окремо; прод — міграція/edge темно, далі повний реліз.

## Notes

- Не змінювати існуючі таблиці гарячого шляху; лише адитивні.
- Секрети не записувати у трекнуті файли (обмеження auto-mode): конфіг bucket/токенів — тільки в environment/vault.
- Чужі зміни в робочій копії (release-controller файли) не чіпати.
- Analytics CLI лишається read-only.
