# Implementation Plan: Картинки ре-стітчу з простору замість сервера

**Feature**: `030-restitch-drive-images` | **Git branch**: робота від `8adbd741` (main); окрема гілка цим викликом не створюється, її створити перед імплементацією
**Spec**: [spec.md](spec.md) | **Date**: 2026-10-08
**Джерело фактів**: [docs/NO_SERVER_MEDIA_PLAN.md](../../docs/NO_SERVER_MEDIA_PLAN.md), розділи «Re-stitching replacement» і R1–R11

## Summary

Сьогодні стартова й фінальна картинки ре-стітчу це локальна бібліотека компресора
власника, скопійована браузером у Supabase-бакет `team-restitch-images`, звідки
браузер іншого учасника копіює їх у локальну бібліотеку його агента. Дві копії
медіа на сервері й у чужій бібліотеці, ідентичність за UUID без відбитка вмісту,
вибір після завантаження всього набору.

Заміна. Пули джерел зберігаються як посилання на матеріали простору в новій
таблиці `team_restitch_sources` (файл або папка, слот, область: простір або
учасник). Ефективний набір обчислює SQL-функція тим самим рекурсивним шаблоном,
що й пули каталогу (`private.product_catalog_pool_images`), з відсівом за
`mime_type`, `size_bytes`, розширенням і `lifecycle`, дедуплікацією за `checksum`
і лімітом 500. **Вибір робить сервер**: `draw_restitch_screens` повертає по одному
матеріалу на слот, рівномірно за унікальними відбитками. Браузер (або
`drive-ops/updater/claim` для фону) видає на обрані матеріали звичайні
`download_range`-гранти агента й передає їх агентові у вже наявних опціях
`process: { tool: 'restitch', … }` новим полем `screens`. Агент кладе байти в
окремий кеш `TeamScreens/<materialId>-<md5>.<ext>` поза бібліотекою компресора,
не перезавантажує те, що має з тим самим md5, і прибирає копії, яких немає в
останньому відомому наборі. Фонові задачі каталогу беруть пул власника, бо
`claim` викликає `service_draw_restitch_screens(team, owner)`; інтерактивна
доставка бере ефективний пул учасника. Старі клієнти відсікаються версією
можливості: `teamRestitchSources: 1` у `AGENT_TOOL_CONTRACTS` для агента і
`restitchContractVersion: 2` у тілі `claim` для вкладки. Вивантажувач у бакет
зникає, INSERT-політика знімається тією самою міграцією; читання лишається до
окремого погодженого видалення.

## Delivery order

Три релізи, кожен сам по собі корисний і відкочуваний.

1. **Реліз A — агент** (`teamRestitchSources: 1`): кеш `TeamScreens`, поле
   `screens` в опціях делегата, cache-first, EXIF-орієнтація, прибирання. Без
   змін на сервері й у вебі агент просто вміє більше. Виходить першим, бо
   `release.ts` звіряється байт у байт зі `stable.json`.
2. **Реліз B — бекенд + веб** (US1–US4): таблиця й функції пулів, `draw`,
   `claim` v2, панель із власним станом, cache-first delivery через гранти,
   стани недоступності, помилки. Простори в режимі `legacy` продовжують
   працювати старим читанням з бакета; вивантажувач вимкнений, INSERT-політика
   знята.
3. **Реліз C — перехід** (US5): перенесення старих картинок у `Soty/Re-stitch
images`, стан «потребує перевибору», `delete-account` чистить бакет, інвентар
   і окрема погоджена міграція видалення об'єктів.

## Technical Context

**Language/Version**: TypeScript strict, ESM NodeNext (Node 22 для агента; Deno для edge-функцій); SQL для Postgres 15 (Supabase)
**Primary Dependencies**: Fastify (агент), React 19 + Vite + HeroUI v3 (веб), `@video-compressor/shared`, Supabase JS, ffmpeg/ffprobe 7.1.1 (бандл агента)
**Storage**: Postgres (нові таблиця й функції у `public`/`private`), Google Drive через наявні гранти `drive-transfer`, локальна тека агента `TeamScreens` у Application Support; Supabase Storage лише як legacy-читання
**Testing**: vitest single-worker (`--pool=forks --poolOptions.forks.singleFork=true`), PGlite для SQL, jsdom для панелі, `stitch-integration` з реальним ffmpeg (skipIf)
**Target Platform**: macOS Apple Silicon + Windows x64 (агент), Cloudflare Pages (веб), Supabase (edge + DB)
**Project Type**: монорепо web + local agent + shared + edge functions
**Performance Goals**: одна інтерактивна доставка переносить ≤ 2 зображення (по одному на слот); повторна з незміненими джерелами переносить 0; `draw` і `list` для пулу з 500 зображень відповідають за < 300 мс на PGlite-еквіваленті
**Constraints**: нуль записів у Supabase Storage після релізу B; збереження пулів без агента; кеш агента ≤ 500 файлів на простір, прибирання ≤ 30 днів; жодного нового рекурентного полінгу в браузері
**Scale/Scope**: 24 простори, пули до 500 зображень, 98 legacy-об'єктів у бакеті

## Constitution Check

| Принцип                               | Як дотримано                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Контракти з валідацією на межі     | Нові фігури (`RestitchSource`, `RestitchPoolSummary`, `RestitchScreen`, `RestitchDrawResult`) у `packages/shared/src/team/restitch.ts` з guard-парсерами; агент приймає `screens` як `unknown` і парсить; `parseTeamRestitchDefaults` розширюється полем `sourceMode` тотально (старий рядок → `legacy`).                                 |
| II. Одне джерело правди для контракту | `teamRestitchSources: 1` додається лише в `AGENT_TOOL_CONTRACTS` (як `teamPosterFrame`), не в `WEB_TOOL_REQUIREMENTS`, тож `deploy:web` не блокується, а веб читає можливість з `/api/health`. Версія claim живе в `RESTITCH_CONTRACT_VERSION` у shared, не в edge-функції. Реліз A передує B.                                            |
| III. Безпека за побудовою             | Таблиця з RLS, `revoke all` + вузькі `grant select`; усі функції `security definer set search_path = ''`, повні імена; `service_*` лише для `service_role`; `draw` для учасника вимагає `view`, грант на байти вимагає `download` (наявний шлях); INSERT-політика бакета знімається міграцією; жодних секретів.                           |
| IV. Дочірні процеси й ресурси         | Нових spawn немає; EXIF через ffprobe (той самий seam) або байтовий парсер без процесу; кеш пише з `wx`, атомарно через temp + rename; прибирання не тримає відкритих дескрипторів.                                                                                                                                                       |
| V. HTTP-конвенції агента              | Нових роутів агента немає: `screens` їде в наявному `process`-запиті; коди помилок машинні (`RESTITCH_SCREEN_UNAVAILABLE`, `RESTITCH_SCREEN_FETCH_FAILED`), 409/400 за наявною таблицею. Роут `/api/team/restitch-images/:slot/:id` лишається для legacy до релізу C, потім видаляється.                                                  |
| VI. Фронтенд                          | Панель будується з інвентарю (`TaskAttachmentPicker`, `FolderPicker`, `Button`, `Checkbox`, список джерел як у `ProductCatalogSettingsSection`), без нових значень поза токенами; виклики через `teamApi` з guard; станів пулу без полінгу: перечитування при відкритті панелі, після збереження і за наявним Realtime-сигналом каталогу. |

Порушень немає; Complexity Tracking порожній.

## Project Structure

### Documentation (this feature)

```text
specs/030-restitch-drive-images/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── restitch-sources-sql.md      # таблиця, функції, права, коди помилок
│   ├── agent-screens.md             # поле screens в опціях делегата, кеш, можливість
│   └── claim-and-delivery.md        # claim v2, інтерактивний флоу, межа старих клієнтів
└── tasks.md                         # /speckit-tasks
```

### Source Code (repository root)

```text
packages/shared/src/
├── team/restitch.ts                 # +sourceMode, RestitchSource*, RestitchScreen, parsers, RESTITCH_CONTRACT_VERSION
└── release.ts                       # +teamRestitchSources: 1 в AGENT_TOOL_CONTRACTS

supabase/migrations/
├── <ts>_restitch_sources.sql        # таблиця, resolve/list/set/draw, source_mode, коди помилок, drop INSERT policy
└── ROLLBACK.md                      # зворотні кроки
supabase/functions/
├── drive-ops/updater-restitch.ts    # claim v2: draw для власника, гранти на screens, відмова старим
├── drive-ops/index.ts               # прокидання версії claim
└── delete-account/index.ts          # чистка бакета за префіксом користувача (реліз C)

apps/web/src/
├── api/team.ts                      # listRestitchSources, setRestitchSources, drawRestitchScreens, claim v2
├── team/restitch/images.ts          # publish* видаляється; ensureRestitchImages лишається лише для legacy
├── team/restitch/screens.ts         # новий: draw → гранти → screens для агента
├── team/restitch/useRestitchDelivery.ts
├── team/catalog-updater/useRestitchPreparer.ts
├── team/catalog/CreateProductCatalogDialog.tsx
├── team/workspace/RestitchDefaultsSection.tsx   # власний стан форми, пули, стани, перехід
├── team/workspace/RestitchSourcePools.tsx       # новий: два пули з пікерами й лічильниками
├── team/errors.ts, i18n.ts
└── api/client.ts                    # restitchSourcesSupported()

apps/agent/src/
├── team-bridge/screen-cache.ts      # новий: TeamScreens кеш, cache-first fetch, прибирання
├── team-bridge/restitch.ts          # screens у опціях; spaceScreens з кешу, не з бібліотеки
├── team-bridge/download.ts          # пропуск screens у делегат
├── stitcher/exif.ts                 # новий: орієнтація → фільтр transpose/flip
├── ffmpeg/presets.ts                # imageAdaptationFilter приймає орієнтацію
└── compressor/routes.ts             # legacy-роут лишається до релізу C

tests/
├── team-restitch-sources-sql.test.ts        # новий
├── team-restitch-draw-sql.test.ts           # новий
├── team-restitch-screens.test.ts            # новий (web screens.ts)
├── agent-screen-cache.test.ts               # новий
├── stitch-exif.test.ts                      # новий
├── team-restitch-section.test.tsx           # переписати під власний стан
├── team-restitch-delivery.test.ts, catalog-updater-restitch-preparer.test.ts,
│   product-catalog-dialog.test.tsx, updater-restitch-routes.test.ts,
│   team-restitch-defaults.test.ts, team-restitch-storage-sql.test.ts  # оновити
└── stitch-integration.test.ts               # +кейс EXIF і +кейс screens з кешу
```

**Structure Decision**: усе лягає в наявні seams; нові файли лише там, де
з'являється нова відповідальність (пули в панелі, кеш екранів в агенті, EXIF).

## Phase 0 — Research

[research.md](research.md): сім рішень (де робити вибір, ідентичність кешу,
EXIF на ffmpeg 7.1.1, межа старих клієнтів, область пулів для учасника, доля
legacy-режиму й бакета, офлайн-правило). Невирішених `NEEDS CLARIFICATION` немає.

## Phase 1 — Design

- [data-model.md](data-model.md): `team_restitch_sources`, `source_mode` на
  обох таблицях налаштувань, обчислювані стани пулу, кеш агента.
- [contracts/restitch-sources-sql.md](contracts/restitch-sources-sql.md):
  функції `list_restitch_sources`, `set_restitch_sources`,
  `set_member_restitch_sources`, `draw_restitch_screens`,
  `service_draw_restitch_screens`, коди помилок, права.
- [contracts/agent-screens.md](contracts/agent-screens.md): поле `screens`,
  кеш, можливість `teamRestitchSources`, коди помилок агента.
- [contracts/claim-and-delivery.md](contracts/claim-and-delivery.md): claim v2,
  інтерактивний флоу, перехід і межа старих клієнтів.
- [quickstart.md](quickstart.md): як перевірити кожну user story на беті.

## Rollout and rollback

- **A** (агент): нова можливість нікого не змінює; відкат = попередній реліз
  агента.
- **B** (бекенд + веб): міграція аддитивна (нова таблиця, нові колонки з
  дефолтом `legacy`, нові функції). Старі простори лишаються в `legacy` і
  працюють через читання бакета. Відкат вебу повертає вивантажувач, але
  INSERT-політика вже знята, тож відкат вебу без зворотної міграції означає
  «збереження картинок не працює». ROLLBACK.md описує відновлення політики.
- **C** (перехід): перенесення в Drive оборотне (файли в Drive лишаються);
  видалення об'єктів бакета лише окремою міграцією за інвентарем, після
  `beta:verify` і прод-гейтів.

## Complexity Tracking

Порожньо: порушень Constitution Check немає.
