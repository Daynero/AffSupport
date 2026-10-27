# Початкова карта охоплення видалення перекладача

**Дата**: 2026-10-27

**Специфікація**: [spec.md](spec.md)

**Статус**: початкова карта збережена для traceability; реалізацію та фінальний
пошук зафіксовано в [reviews/residuals.md](reviews/residuals.md) і
[reviews/acceptance.md](reviews/acceptance.md).

Мета — не пропустити виконуваний шлях. Це не список файлів для механічного видалення:
частина модулів спільна з оригінальною транскрибацією. Planning має простежити
актуальний граф викликів, імпортів і останні визначення серверних функцій.

## Продуктові поверхні

| Область                 | Де вже знайдено                                                                                                                                                                       | Що перевірити при реалізації                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Сторінка транскрибатора | `apps/web/src/transcription/TranscriptionPage.tsx`, `TranscriptionRow.tsx`, `TranscriptionSettingsPanel.tsx`                                                                          | Автопереклад після завершення; синхронізація цільової мови з мовою UI; дії рядка й bulk; статуси, ETA, пропозиції встановити; старий кешований стан.              |
| Перше встановлення      | `ModelGate.tsx`, `GemmaConsent.tsx`, `TranslatorNotice.tsx`, `TranslationElapsed.tsx`                                                                                                 | Прибрати згоду, комплект моделей, самостійне встановлення, варіант «без перекладу», часткові й помилкові стани; лишити встановлення мовленнєвих моделей.          |
| Перегляд тексту         | `TranscriptTextModal.tsx`, `useTranslationFollow.ts`, `useScrollSync.ts`, `useSemanticSelection.ts`, `alignment.ts`                                                                   | Друга колонка, цільова мова, статус/повтор/скасування, синхронізація мов і семантичне зіставлення; зберегти виділення та відтворення оригіналу.                   |
| Копіювання й експорт    | `ExportMenu.tsx`, `TranscriptionCopyMenu.tsx`, `copy.ts`, `export.ts`, `document-cache.ts`                                                                                            | Варіанти `translation`/`both`, вибір кешованого перекладу, назви й суфікси файлів, invalidation; оригінальні TXT/SRT/VTT і таймінги не повинні постраждати.       |
| Обробити у просторі     | `apps/web/src/team/library/LibraryProcessingProvider.tsx`, `ProcessLibraryDialog.tsx`                                                                                                 | Default/chosen/supported kinds; scan/commit; `created`/`missing`; прогрес, already done, unsupported, retry, deferred scope; один файл, selection, folder, space. |
| Текст відео у просторі  | `apps/web/src/team/library/VideoTextActions.tsx`                                                                                                                                      | Зараз `preferred` спочатку вибирає `kind === 'translation'`; прибрати цю підстановку й перемикач. Тільки legacy-переклад не означає наявний оригінал.             |
| Інші точки доступу      | `team/explorer/PreviewPane.tsx`, `PaneActions.tsx`, `team/catalog/MaterialResults.tsx`, `useMaterialActions.ts`, `team/materials/`, `team/tasks/`, `team/workspace/`, `team/palette/` | Спільний registry дій, preview, деталі, результати пошуку, меню, картки, вкладення, view/copy/retranscribe; перевірити всі consumers текстових варіантів.         |
| Продуктовий текст       | `apps/web/src/locales/uk.ts`, `en.ts`, `pages/legal-content.ts`, `HomePage.tsx`, `lib/tool-registry.ts`, `team/tariffs/SpaceShowcase.tsx`                                             | Згадки фічі, моделей, двомовного режиму, доступні назви, опис можливостей, legal/onboarding; не плутати з локалізацією.                                           |
| Стилі й демонстрація    | `apps/web/src/styles/transcription.css`, `styles.css`, `styles/team-tasks.css`, `apps/soty-review/src/screens/transcription/TranscriptionReview.tsx`                                  | Непотрібні bilingual/alignment/translator стани, fixtures й демонстраційні підписи; не залишати порожню другу колонку або spacer.                                 |

Шляхи без окремого префікса в перших чотирьох рядках відносні до
`apps/web/src/transcription/`; для просторів — до `apps/web/src/`.

## Агент і спільні контракти

| Область                    | Де вже знайдено                                                                                                        | Що має бути охоплено                                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Створення рушіїв           | `apps/agent/src/index.ts`                                                                                              | `createTranslator`, `createAligner`, injection у чергу, стартове housekeeping, shutdown і busy.                                                                                                                           |
| Виконання                  | `apps/agent/src/translation/`, `queue/translation-coordinator.ts`                                                      | Інференс, llama-server, alignment, детектування/встановлення/хеші/URL моделей, preemption, timers, автоматичний pump, кеш і повтор.                                                                                       |
| Черга транскрибації        | `queue/transcription-queue.ts`, `queue/transcription-store.ts`, `queue/transitions.ts`                                 | Перекладацькі downloaders, `workActive`/`running`, callbacks після встановлення, автопереклад, stop all, restart, cancel, пауза, старі settings і summary.                                                                |
| Прихований другий прохід   | `whisper/transcriber.ts`, виклик у `queue/transcription-queue.ts`                                                      | `createEnglishPivot: true`, Hindi/Urdu, `translateToEnglish`, прапорець `-tr`, `pivot` phase і `englishText`/`englishWords`. Окремо перевірити інші call sites.                                                           |
| Спільне розбиття оригіналу | `whisper/chunks.ts`, `whisper/words.ts`, `whisper/transcriber.ts`, `transcription/document-store.ts`                   | Вони імпортують `lexicalUnitSpans` / `splitTextForTranslation` з `translation/segmentation.ts`; зберегти необхідну поведінку слів/сегментів, не видалити разом із каталогом.                                              |
| Документ і збереження      | `transcription/document-store.ts`, `transcription/export.ts`                                                           | `translationSource`, `translations`, кеш, validators, legacy parse, save-with-translation; справний оригінал переживає старі/пошкоджені translation fields.                                                               |
| Межа локальних запитів     | `transcription/routes.ts`, `apps/web/src/api/client.ts`                                                                | Settings, translator download/cancel, GET/POST/DELETE translations, save-with-translation, документ і SSE. Старі запити не запускають дію; історична сумісність не є активним API фічі.                                   |
| Командне виконання         | `team-bridge/process.ts`, `team-bridge/library.ts`                                                                     | Delegate `translation`, `transcriptionDelegate(..., true)`, `targetLanguage`, очікування translation, progress, output `translation.txt`, fingerprint, внесок виконавця, transfer/finalize.                               |
| Shared                     | `packages/shared/src/types.ts`, `lifecycle.ts`, `team/library-processing.ts`, `team/creative-library.ts`, `release.ts` | Активні типи, lifecycle, settings/defaults, targets, errors, cache keys, documents, supported kinds, contributions, variants/sidecar names та сумісність tool contracts. Історичні коди мають окреме інертне трактування. |
| Resource/platform seams    | `apps/agent/src/power/`, `apps/agent/src/platform/`, shared cancel/shutdown                                            | Жодних залишених governor holds, child processes, timers чи зайвих capability requirements; не ламати платформні механізми решти інструментів.                                                                            |

Шляхи агента без префікса відносні до `apps/agent/src/`.

## Простір, збережені дані й серверні межі

- `apps/web/src/api/team.ts`: scan `created`/`missing` містить обов’язковий `translation`;
  parser задач явно приймає його. Зміна лише UI не усуває ці контракти.
- `supabase/functions/drive-ops/index.ts`: активний `translation` tool з власним
  contractVersion, перевірка результатів поряд із transcription та загальний pipeline.
  Перевірити prepare/claim/heartbeat/finalize/retry й повноваження старого виконавця.
- `supabase/functions/_shared/library.ts`: companion role `translation`; обмежити
  нову публікацію й не зламати читання звичайних існуючих матеріалів.
- SQL-історія `20260814100000_creative_library_foundation.sql`,
  `20260814101000_creative_library_actions.sql`, `20260830150000_video_text_variants_companion.sql`,
  `20260906010000_library_processing_reaches_catalog.sql` та наступні перевизначення
  функцій включно з `20260916190000_batch_chooses_its_work.sql` містять translation kinds,
  планування, підрахунок і companion variants. Знайти **останні чинні** визначення
  `scan_library_requirements`, `claim_library_job` та всіх пов’язаних finalize/read функцій.
- Сканування не має планувати переклад навіть із default/null kind selection або старим
  interface language. Старі requirements не можуть повертатися через lease expiry,
  rescan, source-version change або retry. Видалення поля з UI не закриває старих writers.
- Нова канонічна міграція/перехід, якщо потрібні, мають зберегти history і користувацькі
  дані; не редагувати застосовані міграції. Перевірити чисте відтворення ланцюжка та
  оновлення зі старими рядками, включно з constraints і старими ролями доступу.
- Не видаляти реальні txt/Drive/R2/інші provider-файли, не переписувати їхній вміст,
  не трактувати legacy translation companion як оригінал і не робити provider cleanup
  частиною вилучення. Уже збережений звичайний файл лишається доступним за своїми правами.
- Визначити просту, ідемпотентну межу припинення невиконаних старих робіт;
  її авторитетний стан має відхиляти late finalize, не створювати фальшивий success
  і не чекати нескінченно на офлайн-агент. Це не універсальна нова система recovery.

## Пакування, документація та перевірки

- macOS: `scripts/package-mac.sh`, `package-dev-mac.sh`, `package-beta-mac.sh`,
  `verify-package.sh`, `verify-dev-package.sh`, а також чинні перевірки beta.
- Windows: `scripts/stage-windows-runtime.mjs`, `windows-smoke.mjs`,
  `verify-windows-package.mjs`, `lib/windows-package-layout.mjs` та пов’язані workflow inputs.
- `packaging/licenses/`: llama.cpp, Gemma terms/policy/notice, multilingual E5;
  актуальні пакети й notices мають відповідати реальному залишеному складу.
- `README.md`, `THIRD_PARTY_NOTICES.md`, актуальні `docs/`, env examples/registry,
  доступні endpoints, smoke procedures й релевантні поточні agent guides. Прибрати
  `TRANSLATION_*`, `ALIGNMENT_*`, `AGENT_TRANSLATION_CACHE_PATH` як активні налаштування,
  якщо аудит підтвердить їх виключне призначення. Секрети не читати/не виводити.
- `scripts/analytics/code-map.ts`, `coverage-registry.ts`, `apps/web/src/analytics/errors.ts`:
  активну можливість прибрати/позначити історичною за версією; старі факти й коди
  читати без посилань на неіснуючий runtime. Не міняти минулу невідомість на нуль.
- Видимі історія/аудит/внески (`team/workspace/HistoryDialog.tsx`,
  `team/members/TeamAuditPanel.tsx` та consumers contributions): старі системні записи
  не повинні повертати назви перекладача в актуальний UI. Зберегти сам історичний факт;
  нейтральний підпис минулої обробки не означає, що це була транскрибація.
- Регресії: `tests/transcription-*`, `translation-*`, `creative-library-*`,
  `team-preview-transcript.test.tsx`, `team-batch-scope.test.tsx`,
  `material-action-registry.test.ts`, `stop-all.test.ts`, `stop-leaves-nothing-running.test.ts`,
  `power-spawn-coverage.test.ts`, `power-timeout-scaling.test.ts`,
  `lifecycle-*`, `analytics-error-codes.test.ts`, `agent-error-codes.test.ts`,
  `analytics-code-map.test.ts`, `i18n.test.ts` і `supabase/tests/database/creative-library.test.sql`.
  Прибрати очікування живого перекладача; зберегти перевірки оригіналу, історії й безпеки.
- Перевірити нові macOS/Windows пакети й узгодження agent/web/shared/server;
  така зміна не є чистим web-only mini release. Production activation не входить у цю спеку.

## Правила завершального пошуку

Шукати не лише назви моделей: `translategemma`, `gemma`, `translator`,
`translationLanguage`, `translationDeclined`, `targetLanguage`, `translationSource`,
`createEnglishPivot`, `translateToEnglish`, `TranslationCache`, `save-with-translation`,
`kind/role/toolId/action = translation`, `translationSidecarName`, bilingual,
alignment і українські/англійські продуктові тексти про переклад.
Відстежити також непрямі імпорти, копіювання, експорт та серверні за замовчуванням.

Допустимі залишки мають бути обґрунтовані по суті, а не дозволені всім файлом:

1. `Translate`, `TranslationKey`, `useI18n` та словники локалізації інтерфейсу.
2. Користувацькі назви/контент, які продукт не має права переписувати.
3. Незмінна історія міграцій, релізів, доказів і специфікацій, а також ця спека.
4. Мінімальне інертне читання історії або відмова старим запитам, яке має окремі
   перевірки відсутності виконання. Не залишати під цим приводом координатор чи downloader.
5. Справді спільне розбиття/таймінги оригінального тексту; прибрати помилкову залежність
   від видаленої фічі без втрати цієї поведінки.

Для кожної поверхні planning має визначити власника перевірки й acceptance evidence;
реалізація завершується лише після повторного повного пошуку та пояснення залишків.
