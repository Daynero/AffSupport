# Tasks: Переклад транскриптів через Claude

**Input**: `specs/063-transcript-translation/` (spec, plan, research, data-model, contracts, quickstart)

**Формат**: `[ID] [P?] [Story] Опис`. `[P]` — можна паралельно (інші файли, немає залежності).

## Phase 1: Setup

- [x] T001 Додати секрет `ANTHROPIC_API_KEY` і прапорець `SOTY_TRANSLATION_PROVIDER` у `config/environments.json` (`surface:"functions"`, без значень) і в `supabase/functions/.env.example` з порожнім значенням і коментарем.
- [x] T002 Додати блок `[functions.transcript-translate]` у `supabase/config.toml` (`verify_jwt = false`, коментар, як у сусідів).

## Phase 2: Foundational (блокує всі історії)

- [x] T003 [P] `packages/shared/src/transcript-translation.ts`:
  - `TRANSCRIPT_TRANSLATION_FEATURE`, `TRANSLATION_UNITS_PER_MINUTE=900`, `TRANSLATION_TARGET_LANGUAGES`, `isTranslationTargetLanguage`;
  - `normalizeTranslationSegment(s)`, `translationUnits`, `translationFingerprint` (WebCrypto SHA-256, `v1:`);
  - `splitTranscriptLines`, `chunkTranslationSegments(segments, maxUnits)`;
  - типи `TranscriptTranslation`, `TranslationAllowance`, `TranslationStreamEvent`;
  - парсери `parseTranscriptTranslation`, `parseTranscriptTranslationList`, `parseTranslationAllowance`, `parseTranslationStreamEvent`;
  - реекспорт з `packages/shared/src/index.ts`.
- [x] T004 [P] `TEAM_TRANSLATION_ERROR_CODES` у `packages/shared/src/team/transport.ts` (включити в `TEAM_ERROR_CODES`). `STATUS_BY_CODE` у `supabase/functions/_shared/errors.ts`: 429/409/503/422/502/504.
- [x] T005 Міграція `supabase/migrations/20261222110000_ai_allowance_and_usage.sql`:
  - таблиці `ai_feature_allowances`, `ai_allowance_reservations`, `ai_usage_events`, сід ліміту;
  - `private.ai_allowance_used`, `private.ai_allowance_reserve`, `private.ai_allowance_settle`, `private.ai_usage_record`, `public.ai_allowance_status`;
  - гранти. Розділ у `ROLLBACK.md`.
- [x] T006 Міграція `20261222111000_transcript_translations.sql`:
  - таблиця, індекси, тригер `task_cleanup_reference_fence`;
  - `begin/progress/complete/fail/expire`, `list_video_translations`, `list_personal_translations`, `get_transcript_translation`;
  - гранти, `ROLLBACK.md`.
- [x] T007 [P] Міграція `20261222112000_translation_error_codes.sql` (сід у тому самому порядку, що й `TEAM_TRANSLATION_ERROR_CODES`). `tests/team-contract.test.ts` читає новий файл.
- [x] T008 [P] Міграція `20261222113000_ai_usage_analytics.sql`: подання `analytics_ai_usage_daily`, `analytics_transcript_translations`, select для `wishly_analytics_ro`. `ROLLBACK.md`.
- [x] T009 [P] `supabase/functions/_shared/claude.ts`: інтерфейси, `callStructured`, `costMicroUsd`, мапінг помилок, ціни. `_shared/claude-sdk.ts` — адаптер SDK 1.6.0.
- [x] T010 [P] `supabase/functions/_shared/ai-allowance.ts`: типізовані обгортки `rpc` для резерву, врегулювання й обліку.
- [x] T011 Тести фундаменту:
  - `tests/transcript-translation-shared.test.ts` — нормалізація, одиниці TR_25 = 1 841±, відбиток стабільний між рядками/пробілами, шматки не рвуть сегменти, парсери відкидають сміття;
  - `tests/claude-shared.test.ts` — відмова, обрізання, невідповідь схемі, вартість;
  - `tests/transcript-translation-sql.test.ts` — RLS, гранти, `search_path`, тригер, коди, інваріанти міграцій.

**Checkpoint**: фундамент зелений, shared dist перебудовано.

## Phase 3: User Story 1 — переклад у просторі (P1) 🎯 MVP

- [x] T012 [US1] `supabase/functions/transcript-translate/translate.ts`: шматки, паралельність 3, повтор, Sonnet-фолбек, бюджет 240 с, прогрес-колбек, облік кожного виклику.
- [x] T013 [US1] `transcript-translate/handler.ts`:
  - розбір тіла;
  - `start` для `team_video` (джерело через `list_video_text_variants` клієнтом користувача) і `personal`;
  - `watch` (NDJSON);
  - мапінг помилок у конверт.
- [x] T014 [US1] `transcript-translate/index.ts`: `Deno.serve`, CORS, клієнти, `EdgeRuntime.waitUntil`, вибір провайдера (SDK; fake лише без ключа і не на `*.supabase.co`). `fake-provider.ts` з режимами `fake`, `fake-refuse`, `fake-down`.
- [x] T015 [US1] `tests/transcript-translate-function.test.ts`:
  - `start` повторно використовує готовий/поточний переклад;
  - ліміт перевищено → 429 з деталями;
  - відмова → фолбек → `REFUSED` і повернення;
  - кількість рядків не та → повтор;
  - `watch` шле `progress` → `done`;
  - прострочений → `TIMEOUT`.
- [x] T016 [P] [US1] `apps/web/src/translation/api.ts`: `startTranslation`, `watchTranslation` (fetch + NDJSON reader + AbortSignal), `listVideoTranslations`, `listPersonalTranslations`, `getAllowance`. Помилки — `TeamApiError`.
- [x] T017 [P] [US1] `apps/web/src/translation/format.ts`: хвилини й узгоджене округлення (R4), час оновлення ліміту за Києвом.
- [x] T018 [US1] `apps/web/src/translation/useTextVariants.ts`: оригінал + переклади, `start(target)`, потоки `watch` для `processing`, плавний прогрес, перепідписка на `visibilitychange`, stale за відбитком.
- [x] T019 [US1] `TranslateLauncher.tsx` (недавні цільові мови — `localStorage` з try/catch як зручність одного переглядача; FR-002) + `TranslationProgress.tsx` + `apps/web/src/styles/translation.css` (лише токени; нові токени `--translation-*` у `tokens.css`).
- [x] T020 [US1] Підключити у `VideoTextActions.tsx` (compact у `PreviewPane`): кнопка «Перекласти», плашка, чипи мов.
- [x] T021 [US1] Локалі `textTranslation*` в `en.ts`/`uk.ts`.

**Checkpoint**: US1 працює на беті з fake-провайдером.

## Phase 4: User Story 2 — ліміт (P1)

- [x] T022 [US2] `TranslateLauncher`: стани «не вистачає» / «довше за день» / «вже перекладено» / «недоступно» за `contracts/ui.md`. Перечитування ліміту після кожного `start`, `done`, `failed`.
- [x] T023 [US2] pgTAP `supabase/tests/database/transcript-translation.test.sql`:
  - паралельний резерв не перевищує ліміт;
  - повернення при `fail`;
  - `held` старший за 6 хв не рахується;
  - новий день за Києвом → повний ліміт;
  - `begin` повторно використовує.
- [x] T024 [US2] Тест UI `tests/translation-ui.test.tsx`: узгоджене округлення (FR-012), відсутність кнопки при нестачі, тексти з числами.

## Phase 5: User Story 3 — кілька перекладів, перегляд і копіювання (P1)

- [x] T025 [US3] `TextVariantTabs.tsx`, `TextVariantReader.tsx`, `CopyVariantButton.tsx`.
- [x] T026 [US3] Вікно перегляду простору у `VideoTextActions.tsx`:
  - заміна `<pre>` на читач;
  - вкладки, stale-попередження з «Оновити переклад»;
  - копіювання вибраного.
- [x] T027 [US3] Тести в `tests/translation-ui.test.tsx`: перемикання, копіювання вибраного варіанта, меню копіювання з кількома, клавіатура/ARIA, RTL `dir`. Перевірити, що `tests/team-preview-transcript.test.tsx` (старі варіанти 046 приховані) зелений.

## Phase 6: User Story 4 — транскрибатор (P2)

- [x] T028 [US4] `TranscriptTextModal.tsx`: вкладки в слоті шапки, читач перекладу з підсвіткою поточного сегмента, плашка, копіювання вибраного.
- [x] T029 [US4] `ExportMenu.tsx`/`export.ts`: експорт вибраного варіанта (TXT/SRT/VTT з таймінгами оригіналу).
- [~] T030 [US4] ~~`TranscriptionCopyMenu.tsx`: пункти перекладів~~ — **свідомо не робили**: це пакетне копіювання всіх готових текстів сторінки, а не меню одного рядка. Вибір перекладу для копіювання й експорту живе у вікні перегляду (T028/T029).
- [x] T031 [US4] Тести: експорт SRT перекладу зберігає таймінги, меню копіювання показує переклади. `translation-retirement-surfaces` лишається зеленим.

## Phase 7: User Story 5 — прогрес і збої (P2)

- [x] T032 [US5] Тексти й дії станів `failed` (refused/unavailable/failed/timeout) у плашці, повтор на місці; перепідписка після повернення до вкладки.
- [x] T033 [US5] Тести: закрити/відкрити → `watch` відновлює прогрес; `failed` → кнопка повтору; прогрес монотонний.

## Phase 8: User Story 6 — аналітика (P3)

- [x] T034 [US6] Веб-події: `flow_step: 'transcript_translation'` у `apps/web/src/analytics/events.ts`. Стадії `requested`, `started`, `completed`, `failed`, `opened`, `copied` з `target_language`, `units`, `scope`, `code`, без тексту.
- [x] T035 [US6] CLI `npm run analytics -- ai-usage [--period] [--json]` у `scripts/analytics/*`: вартість, виклики, моделі, відмови, мови, топ користувачів за хвилинами. Розділ перекладів у `investigate`. Коди в `code-map.ts`, нова можливість `translation.transcript` у `coverage-registry.ts`.
- [x] T036 [US6] Тести CLI (запит лише SELECT, форма JSON), `tests/analytics-code-map.test.ts` зелений.

## Phase 9: Polish

- [x] T037 Документація:
  - `docs/DESIGN.md` — розділ «Переклад транскриптів»;
  - `AGENTS.md` — рядок у таблиці аналітики `ai-usage`;
  - `docs/SUPABASE_SETUP.md` — секрет.
- [x] T038 `npm run format`, `lint`, `typecheck`, `check-design-tokens`, `check-tailwind-classes`, `verify-styles`, `npm run verify`.
- [x] T039 Бета: накатити міграції через psql, задеплоїти функцію локально з `fake`, пройти quickstart 1–8 у Chrome, виправити знайдене.
- [ ] T040 Коміт у гілку `063-transcript-translation`, пуш. Реліз — окремо, на слово власника (next fast path: веб + бекенд-план з міграціями й функцією).

## Dependencies

- Setup → Foundational (T003–T011) → US1 (T012–T021) → US2/US3 (паралельно) → US4 → US5 → US6 → Polish.
- T012–T014 залежать від T003, T009, T010, T005–T006.
- T018–T020 залежать від T016–T017.
- US4 використовує компоненти US3 (T025).

## Відступи від плану (зафіксовано під час реалізації)

- **T023**: замість pgTAP — `tests/transcript-translation-db.test.ts` на повному ланцюжку міграцій у PGlite. Покриває: резерв, відмову з деталями, повернення, повторне використання, завислу спробу, видимість і запобіжник прибирання. Запускається в звичайному suite і не потребує піднятого Supabase.
- **Сервісні функції** (`begin/progress/complete/fail`, `reserve/settle/usage_record`) лежать у `public` з префіксом `service_` і грантом лише для `service_role`: PostgREST не відкриває схему `private`, як і решта функцій простору (`service_claim_task_cleanup`).
- **Fake-провайдер**: вмикається за `SOTY_ENVIRONMENT=beta` і відсутністю ключа, не за доменом.
- **T030** — див. вище.
- **T039 (бета, 2026-11-21)**: пройдено в Chrome з fake-провайдером:
  - простір: вибір мови з вартістю, плашка прогресу, автовідкриття, дві мови, «Уже перекладено», нестача ліміту;
  - транскрибатор: TR_25 розпізнано локально → переклад → повторне відкриття;
  - облік, резерви й рядки перекладів у базі узгоджені.
  Знайдено й виправлено: розділ «Транскрипція» був прихований у просторі лише для читання, хоча текст є; чипи-перемикачі; «Оригінал · UNKNOWN»; перенос рядка вартості.
- **Бета без мережі**: VM colima `soty-beta-047` втратила вихід в інтернет. Пакети `@anthropic-ai/sdk@1.6.0` (+ залежності й `zod`) покладено вручну в npm-кеш Deno контейнера edge runtime (volume переживає перезапуск).
