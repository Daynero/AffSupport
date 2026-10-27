# Validation guide: translator retirement

Це набір перевірок; фактично виконані команди й межі — у `reviews/acceptance.md`.
Дизайн: [plan.md](plan.md), [contract](contracts/retirement.md), [data model](data-model.md).

## Preconditions and isolation

- Чистий candidate у власному checkout/worktree після узгодженого включення фічі;
  не stash/reset чужі зміни й не зупиняти чужу роботу.
- Чинна локальна Supabase для isolated DB runner; тільки локальні fixture дані,
  без production credentials/rows. Beta потребує справжньої auth/entitlement, не dev auth.
- Один heavy child одночасно, nice15, single test worker, bounded memory. Не запускати
  наступну важку команду, доки попередня не завершилася.
- Fixture models можуть бути порожніми контрольними файлами у власному temp root;
  не завантажувати 2.6GB для доказу відсутності використання. Для real speech acceptance
  потрібна чинна мовленнєва модель; missing binary/model означає missing evidence, не PASS.

## Focused regression runs

Спочатку failing tests з tasks, потім реалізація й ті самі checks:

```bash
nice -n 15 npm run build -w @video-compressor/shared
nice -n 15 npx vitest run tests/transcription-retirement.test.ts tests/transcription-store.test.ts tests/transcription-document.test.ts tests/transcription-reliability.test.ts tests/transcription-quality.test.ts --maxWorkers=1 --no-file-parallelism
nice -n 15 npx vitest run tests/transcription-retirement.test.ts tests/creative-library-processing.test.ts tests/creative-library-agent.test.ts tests/process-output-upload.test.ts --maxWorkers=1 --no-file-parallelism
nice -n 15 npx vitest run tests/transcription-selection-dom.test.ts tests/transcription-viewer-hooks.test.tsx tests/transcription-player.test.tsx tests/transcription-export.test.ts tests/team-preview-transcript.test.tsx --maxWorkers=1 --no-file-parallelism
nice -n 15 npx vitest run tests/translation-retirement-diagnostics.test.ts tests/analytics-code-map.test.ts tests/analytics-schema-compat.test.ts --maxWorkers=1 --no-file-parallelism
SOTY_TEST_DB_SOURCE_PROJECT=acceptance036 nice -n 15 npm run test:db
SOTY_TEST_DB_SOURCE_PROJECT=acceptance036 nice -n 15 node scripts/test-translation-retirement-upgrade.mjs
```

Регресії retirement і feature-only upgrade harness реалізовані; їх запуск потребує
зазначених нижче локальних prerequisites.
`npm run test:db` перевіряє clean replay всієї chain і current-schema pgTAP. Він
**не** доводить upgrade: tests запускаються після всіх міграцій. Окремий
`test-translation-retirement-upgrade.mjs` (T032) створює власний schema/roles-only clone,
replay canonical prefix до першої feature migration, seed sanitized old fixtures,
застосовує feature tail і запускає upgrade-postgres assertions. Два свіжі prefix
сценарії перевіряють finalize-before-retirement і retirement-before-finalize через
DB barriers; не seed old rows після new guards і не вимикати guards. PGlite не
замінює реальну PostgreSQL lock/race перевірку. New harness має local-only source,
owned loopback target, 1 CPU/512MiB, cron off, timeout і cleanup на failure/signal;
не копіює application rows/passwords, не приймає remote URLs, не змінює source або
універсальний runner. Відсутня prerequisite тут є failure/missing evidence, не PASS.

## Acceptance matrix

| Сценарій                      | Дії                                                                                                         | Очікуваний результат / evidence                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Clean macOS/Windows           | First-run speech install→audio/video→view/copy/TXT/SRT/VTT                                                  | Original-only, no Gemma consent/download/process, source timing/playback працюють                   |
| Upgrade без/із/partial model  | Load old state/doc/settings, restart, retry                                                                 | Original доступний; summary/payload/pivot warning відсутні у DTO; artifacts на диску не використані |
| Corrupt legacy payload        | Valid core + invalid translations/translationSource                                                         | Original читається; invalid core окремо refused                                                     |
| Hindi/Urdu                    | Реальне мовлення, fast/accurate                                                                             | Мова оригіналу, нуль -tr/pivot; source progress коректний                                           |
| Original selection            | Pointer drag, keyboard selection, search, playback follow                                                   | Single-column ranges/scroll/karaoke без target mirror                                               |
| Single/selection/folder/space | Dry scan→choose→commit→claim→finish, повторний scan                                                         | Active kinds/counts only; original/landing/preview працюють, no translation work                    |
| Старі library states          | pending/leased/running/failed/stale/ready; expiry/cancel/fail/heartbeat/retry/late accept                   | Нетемінальні припинені, ready збережені, нічого не воскресає                                        |
| Generic старий grant          | Process input, output/start, output/finalize, browser upload/finalize, SQL direct service call              | Stored translation intent fenced; no new adoption/contribution; auth/lease/source guards збережені  |
| Concurrent finalize           | Дві PostgreSQL sessions: retirement з lock/finalize у протилежному порядку                                  | До cutover прийнятий result збережений; після cutover new registration refused, no resurrection     |
| Legacy companion only         | Original+translation / тільки translation / original companion без library result                           | Original-only chooser; old translation не original; fallback працює                                 |
| Group file actions            | move/copy/share/trash/restore legacy sidecar group                                                          | Файли/links/права збережені, generic file доступний; no feature label                               |
| Versions                      | Web6/agent6; web6/agent5; web5/agent6                                                                       | Два mixed pairs blocked до tool requests, не лише інший текст кнопки                                |
| UI audit                      | uk/en × light/dark × keyboard/touch × normal/empty/loading/error/disconnected                               | Немає системних згадок фічі, target/both/export, пустої другої колонки                              |
| Missing/late delivery         | Drop terminal/visible, delay journal, recovery >8 проміжних переходів, old schema, as-of before updated row | Explicit unknown/partial/truncated, не invented success/zero                                        |
| Rest of tools                 | Compressor/stitcher/landing/preview/sync/tasks, pause/stop-all/shutdown                                     | Немає додаткових залежностей чи завислих governor holds/processes                                   |

Приймальні сценарії використовують контрольовану затримку/бар’єр двох DB sessions,
не flaky sleeps. Пакування/міграції в цій інструкції лише локальні; production не чіпати.

## Read-only diagnosis

Використовувати існуючий CLI, не ad-hoc SQL. Для локальних fixture readers — tests;
нижче команди для вже авторизованого read-only середовища з відомими fixture/реальними IDs:

```bash
npm run analytics -- inspect <attempt-or-operation-id> --json
npm run analytics -- investigate <installation-or-operation-id> --period 30d --as-of <iso-instant> --json
npm run analytics -- audit --period 30d --as-of <iso-instant> --json
```

Очікування: last proven stage, FEATURE_RETIRED для справді відхиленого запиту,
retired current lifecycle API6, historical unknown usage незмінний, missing view або
запізнілий сигнал explicit. Відсутність подій не є негативним network/process proof.
Власний контрольний mock/trace фіксує нуль translator download/spawn; збір не містить
реального контенту, paths, provider payloads, secrets або inventory моделей.

## Final gates and artifacts

```bash
nice -n 15 npm run verify
nice -n 15 npm run verify:release
```

Після цього local packaged beta acceptance на exact candidate за `docs/BETA.md`,
macOS/Windows package checks за чинними runbooks. Не виконувати production release
або version bump лише тому, що задачі чи quickstart готові.

Зберегти у `specs/046-remove-translator/reviews/acceptance.md` фактичні candidate SHA,
platform/build, команди/результати, skipped/missing prerequisites, migration replay/
upgrade/race, UI/screenshots, privacy/CLI evidence й остаточний residual search.
Не фіксувати PASS там, де сценарій не запускався.

Known baseline до реалізації: verify від 2026-10-27 мав 13/14 gates; suite впав на
`tests/performance-budgets.test.ts`, 46 086 > 40 000. Не піднімати ліміт і не приховувати
failure. Новий кандидат потребує власного фактичного gate result.
