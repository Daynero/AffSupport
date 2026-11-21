# Задачі 064 · Помічник запусків і чарунки

[План](plan.md) · [Приймання](quickstart.md). `[P]` — можна паралельно з сусідніми задачами тієї самої фази. Vitest запускати single-worker (`--pool=forks --poolOptions.forks.singleFork=true`), перед важким запуском перевіряти `uptime`.

## Фаза 1 · Основа

- [X] T001 Перебазувати гілку на `origin/beta` і зафіксувати SHA в `research.md`. Звірити точки 063 (`_shared/claude-sdk.ts` — повтори, `_shared/ai-allowance.ts`, міграція `20261222110000`). Перевірити, чи доступний spend limit на workspace у Claude Console для нашої організації. FR-024 FR-028
- [X] T002 [P] Реєстр полів `packages/shared/src/team/launches/fields.ts`: рівні 1 і 2, типи, межі, умови доступності, маска дефолтів, операції, синоніми. Генератор JSON Schema для `plan_launch_actions`. `tests/launch-field-registry.test.ts`: інвентар контролів `LaunchEditor` і дочірніх компонентів червоніє на незареєстрованому полі. FR-008 SC-007
- [X] T003 [P] `packages/shared/src/team/launches/defaults-merge.ts`: чисте злиття «офер → простір → вбудоване» з явним часом і поясом, маска полів, legacy-бюджет без мінімуму. Тести на нову й існуючу чернетку, відсутній профіль і помилку читання. FR-004 FR-010
- [X] T004 [P] `packages/shared/src/ai/pricing.ts`: `translationPrice(units, language, version)`, `assistantPrice(text, version)`, округлення вгору, мінімум 1, версії. `tests/ai-pricing.test.ts`. FR-023 FR-024 FR-025
- [X] T005 Міграція чарунок: `ai_settings`, `ai_credit_grants`, `ai_credit_ledger`, `ai_budget_months`, `ai_admin_events`, нові колонки `ai_usage_events`. RPC `ai_credits_status()`, `service_ai_credit_debit/refund` з блокуванням користувача, `ai_month_holds` під спільним блокуванням місяця. `supabase/tests/database/ai-credits.test.sql`: паралельні debit на останні чарунки, refund у ту саму добу, північ і перехід часу, підвищення гранту, двоє користувачів біля межі місячного бюджету (лише один hold), ліміт нижче витраченого. FR-022 FR-026 FR-028 FR-030 SC-010 SC-011
- [X] T006 `supabase/functions/_shared/ai-credits.ts`, правки `_shared/claude.ts` і `claude-sdk.ts`: без прихованих повторів, usage «невідомо» замість нуля, точні USD, кешований префікс, звірення невизначених спроб (≤ 15 хв, потім refund). `tests/ai-credits.test.ts`. FR-021 FR-026
- [X] T007 Міграція помічника за [моделлю даних](data-model.md): розмови, повідомлення, команди, ефекти, питання, URL-слоти, перегляди, `team_launches.created_via` / `assistant_command_id`, пілот. RLS, cleanup fence, cron TTL 7 днів. `supabase/tests/database/assistant-access.test.sql`: два простори, автор/учасник/чужий/service, прямий виклик без UI. FR-002 FR-018 FR-032
- [X] T008 RPC `save_launch_offer_defaults_masked` + pgTAP: паралельна правка іншого поля зберігається, того самого — `EDIT_CONFLICT`, повтор ключа — один ефект. FR-010 SC-008

## Фаза 2 · Історія 1 — MVP

- [X] T009 `packages/shared/src/team/assistant.ts`: операції, дії плану, картки, коди причин, детермінований розпізнавач коротких реплік («запускай», «покажи», «скасуй», «так/ні»). Тести розпізнавача. FR-013 FR-019 FR-021
- [X] T010 `supabase/functions/assistant/interpret.ts`: контекст (URL → позначки, довідники ≤ 200 назв, структурований стан), строгий інструмент зі схемою з T002, системний опис з реєстру, підміна провайдера для тестів. FR-019 FR-020
- [X] T011 [P] `supabase/functions/assistant/resolve.ts`: зіставлення офера, баєра, РК і матеріалів (псевдоніми TR_16, «шістнадцяте», транслітерація, помилки диктування, країна як підказка). `tests/assistant-resolve.test.ts`. FR-007
- [X] T012 `supabase/functions/assistant/handler.ts` + `execute.ts`: межі FR-034, ціна й debit, перевірка плану, розгортання `create_drafts`, `save_launch_draft` з ключами кроків, запис ефектів, картка результату. `tests/assistant-drafts.test.ts`: історія 1, повтор доставки, недоступний офер. FR-003 FR-004 FR-005 FR-006 FR-012 FR-034 SC-001 SC-003 SC-009 (рахувати виклики Claude на 1 і 20 чернеток)
- [X] T013 Веб: `AssistantComposer` у `LaunchSpace`, `AssistantPanel` (бокова панель / повноекранний шар на вузькому), картка результату, мітка «з помічника» й підсвітка в `LaunchCard`, відкриття в `LaunchEditor`. `tests/assistant-composer.test.tsx`: клавіатура, Ctrl/⌘+Enter, вставлення, 0 викликів до надсилання, відновлення після перезавантаження. FR-001 FR-003 FR-018

## Фаза 3 · Історії 2, 3, 5 — щоденна користь

- [X] T014 `question.answer`, `update_fields` з expected version і `EDIT_CONFLICT`. Порядкові посилання за `contextCardId`. `tests/assistant-context.test.ts`: три формулювання історії 2, рівно 2 змінені поля, відповідь кнопкою без Claude, дві вкладки з наборами А і Б («у другому» змінює рядок набору А). FR-007 FR-009 SC-002 SC-003
- [X] T015 `supabase/functions/assistant/review.ts`: «мої на сьогодні» за `created_by` і датою в поясі запуску, `limit 101`, версії, неготові з причиною. FR-012 FR-014
- [X] T016 `review.launch` → приймання пакета 053 (`drive-ops/launch-batch.ts`) з версіями рядків і ключем; `REVIEW_CHANGED`; повтор → той самий `batchId`. `tests/assistant-launch.test.ts` + pgTAP. FR-013 FR-015 SC-004 SC-009 (0 викликів Claude на перегляд, запуск, повтор)
- [X] T017 Веб: картка перегляду з «Запустити N», картка стану з доменних квитанцій. `tests/assistant-launch-ui.test.tsx`: зміна в іншій вкладці, північ між показом і натисканням, обрив, 4 з 5 готових. FR-016 SC-004
- [X] T018 `supabase/functions/assistant/undo.ts` + транзакційна RPC відкату ефектів. Відкат правок по полях. `tests/assistant-undo.test.ts`: 70 → 70; 3 змінено й 2 запущено → 65 + звіт; помічник змінив бюджет, людина — нотатку → бюджет повернуто, нотатку збережено; повтор — один ефект. FR-017 SC-006
- [X] T019 Веб: «Скасувати» на картці результату, звіт «скасовано / лишилось з причиною». FR-017
- [ ] T020 Чекпоінт: історії 1, 2, 3, 5 на локальній beta з підміною провайдера через браузер.

## Фаза 4 · Історія 7 — чарунки на кнопках

- [X] T021 `apps/web/src/components/CreditsButton.tsx` у хедері `App.tsx` замість тригера `SupportButton` (компонент і меню зберегти). Панель: смуга доби, час поновлення, ціни, 10 останніх списань, «Помічник запусків». Таймер до київської півночі, перечитування при поверненні у вкладку. `tests/credits-button.test.tsx`: 0, 72%, DST, вузький екран, клавіатура, зміна користувача. FR-027 SC-011
- [X] T022 «Надіслати · N» у `AssistantComposer`: лічильник символів, «Бракує N · поновиться о 00:00», `PRICE_CHANGED`, ціна 0 для детермінованих реплік. FR-023 FR-025
- [X] T023 Переклад 063 на чарунках: «Перекласти · N» у `TranslateLauncher` в обох місцях, `transcript-translate` через `ai-credits`, робота й платник закріплюються в одній транзакції під блокуванням ключа роботи (тест: двоє одночасно → один переклад, один виклик Claude, одне списання), приєднання без списання, приватність платника, прапорець `translation_billing`, `CLIENT_UPGRADE` для старого клієнта. `tests/translation-credits.test.ts` + pgTAP. FR-024 SC-010

## Фаза 5 · Історії 4 і 6

- [X] T024 `create_drafts` з `perAccount`, `overrides`, `dates` (`each_day:N`), межі 100/1000 до першого запису, недоступна опція з причиною. `tests/assistant-multi-account.test.ts`: G1–G5 × 5 кампаній, винятки G1/G3, R2 недоступний, 14 днів. FR-005 FR-006 SC-005
- [X] T025 `tests/assistant-launch-parity.test.ts`: для кожного поля рівня 1 створення й правка текстом проти ручного введення дають ту саму збережену чернетку. Поля рівня 2 вмикаються в реєстрі по одному разом зі своїм тестом. FR-008 SC-007
- [X] T026 `save_offer_defaults` завжди як пропозиція → `profile.confirm` → запис через T008, залежні кроки чекають підтвердження, ланцюжки `step:n` / `copy_of`. `tests/assistant-default-chain.test.ts`: одна репліка і три, «це» з двох джерел, без `manage_metadata`, збій після двох із трьох чернеток. FR-010 FR-011 SC-008
- [X] T027 Веб: картка підтвердження профілю «офер · поле · було → буде». FR-010

## Фаза 6 · Історії 8 і 9, модель

- [X] T028 `apps/web/src/pages/admin/AiBudgetPanel.tsx` + RPC з `is_admin()`: ліміт, витрачено, функції, прогноз, доступно USD для нових викликів, сценарій повного використання грантів активними, покриття ціною, невідомий usage, базовий і персональний грант, пілот, вимикачі, журнал. `tests/ai-budget-panel.test.tsx`: 100 → 150 при 40, $40/$100 за 10 із 30 днів, без даних, досягнутий ліміт. FR-028 FR-029 FR-030 FR-031 SC-011 SC-012
- [X] T029 `tests/assistant-security.test.ts`: уся матриця [контракту доступу](contracts/security.md) з підміною провайдера, звірка БД, черги, мережевих звернень і журналів. FR-032 FR-033 FR-034 FR-035 SC-013
- [ ] T030 (обв'язку й корпус зроблено та перевірено на підміні; лишився платний прогін з ключем: `ANTHROPIC_API_KEY=… npx tsx scripts/acceptance/assistant-model-benchmark.ts --paid --cap 3`, а Sonnet — лише якщо Haiku не пройде, з `--cap 20`) Корпус `tests/fixtures/assistant/uk-commands.json` (налаштування + закритий контроль, ≥ 20 різних команд на клас у контролі) і `scripts/acceptance/assistant-model-benchmark.mjs`. Спершу перевірити на підміні з відомими сумами, потім платний прогін Haiku 5.5 low/medium (стеля $3). Sonnet 5.5 low — лише якщо Haiku не пройшла (стеля $20). Звіт `model-results.md`: пороги, вартість на 100 реплік, таблиця `assistant_price_v1` (FR-025), ставка перекладу. FR-036 SC-014

## Фаза 7 · Діагностика та приймання

- [X] T031 `apps/web/src/analytics/events.ts`, `scripts/analytics/coverage-registry.ts`, `investigate.ts`, `code-map.ts`: стадії й коди FR-037 для помічника, чарунок і перекладу. `tests/assistant-analytics.test.ts`: успіх, частковий, відмова, обрив, повернення, невідомий usage, відсутність приватного вмісту. FR-037 SC-016
- [ ] T032 Локальна beta: увесь [quickstart](quickstart.md) у браузері з реальною локальною авторизацією.
- [ ] T033 Перед релізом: format, lint, typecheck, пов'язані тести й міграції на beta до старту раннера.
- [ ] T034 Реліз на next повним раннером. Пілот Goor, перемикання `translation_billing`, нагадування власнику про spend limit у Console.
- [ ] T035 Замір SC-015 у Goor на next: 5 запусків формою проти помічника, p95 часу відповіді. Результат записати в `model-results.md`.

## Залежності

- T002–T004 паралельні. T005 → T006. T007 і T008 незалежні від T005.
- MVP (фаза 2) потребує T002, T003, T006, T007.
- Фаза 3 потребує фази 2. T016 потребує T015, T018 — T012.
- Фаза 4: T021 і T022 потребують T005; T023 потребує T005 і T006.
- Фаза 5 потребує фази 2; T026 потребує T008.
- Реальний провайдер вмикається лише після T029 і T030. Реліз (T034) — після T031–T033.
