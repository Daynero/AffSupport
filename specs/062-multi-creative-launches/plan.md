# Implementation Plan: Кілька креативів і зображення в каталожних запусках

**Branch**: `062-multi-creative-launches` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/062-multi-creative-launches/spec.md`

## Summary

Каталожний запуск приймає будь-яку кількість креативів одного типу (межа — 400 товарів, кількість товарів автоматично ≥ кількості креативів). Відео: кожне — окремий сегмент суцільних рядків і, з перезашивкою, власний набір `catalog_video_sets`; варіації роздаються по колу. Зображення: каталог генерується ідентично каталогу з білими (ті самі тексти), а `image_link` блоку замінюється посиланням креативу (R2 `c1/…` або Drive за перемикачем R2) одразу або в час розкладу; відеоколонок і перезашивки немає. Розклад публікації, перезашивка оновлювачем і R2 працюють по сегментах; менеджер каталогів для кількох креативів показує лише дозволені власником дії. ID кожного нового товару починається з назви креативу. Розподіл копій — чиста shared-функція з повзунками й полями в редакторі. Конфігурація зберігає список креативів і дзеркалить перший у старі поля, тому десятки SQL-читачів `config->>'materialId'` лишаються правильними без змін. Агент не змінюється: фоновий виконавець і так бере набори по одному.

## Technical Context

**Language/Version**: TypeScript 5 strict (NodeNext ESM), Deno для Supabase Edge Functions, PostgreSQL 17 (PL/pgSQL)

**Primary Dependencies**: React + HeroUI v3 (через `apps/web/src/components/ui/`), Supabase (RLS, RPC, Realtime, pg_cron), Cloudflare R2 (S3 API), Google Drive API

**Storage**: Postgres (`team_launches.draft_config`, `team_launch_revisions.config` jsonb; нові `private.launch_catalog_video_segments`, `private.launch_creative_images`, `private.launch_creative_image_uses`), R2 публічний бакет зображень каталогу, Google Sheets (каталог)

**Testing**: vitest single-worker (`--pool=forks --poolOptions.forks.singleFork=true`), pgTAP/SQL-тести в rolled-back транзакції на беті, Playwright-драйвер на беті для приймання UI

**Target Platform**: веб (Chrome/Safari desktop), Supabase Edge, агент macOS M-серії/Intel і Windows — без змін коду агента

**Project Type**: монорепо web + shared + edge functions + agent

**Performance Goals**: публікація зображень послідовно з чекпойнтом на кожне (≤ 50 МБ), функція поступається й продовжує за бюджетом часу; розподіл у UI — < 16 мс на зміну при k=400 (O(k log k))

**Constraints**: k ≤ N ≤ 400; старі запуски/каталоги без міграції даних; нові таблиці з RLS і `task_cleanup_reference_fence`; без нових секретів; прод не чіпати (реліз лише на next)

**Scale/Scope**: ~24 акаунти, 19 просторів; зміни в ~40 файлах web/shared/edge, 4–5 міграцій

## Constitution Check

| Принцип | Як дотримано |
|---|---|
| I. Типи й валідація на межі | `LaunchCreative`, коди відмов — дискримінований результат `parseLaunchConfig`; межі (`CATALOG_PRODUCT_COUNT_MAX`, `CATALOG_ID_PREFIX_MAX`) — константи shared; edge розбирає `segments` як `unknown` |
| II. Єдине джерело релізу | версії/протокол не змінюються; `AGENT_API_VERSION` без змін; shared `dist` перебудовується перед перевірками |
| III. Безпека | нові таблиці `private.*`, RLS + `revoke all`, RPC `security definer` + `search_path=''`; Drive-докази перед читанням зображення; анонімна перевірка публічного читання; без секретів у треканих файлах |
| IV. Дочірні процеси | агент не змінюється |
| V. Помилки | стабільні машинні коди (`CREATIVES_MIXED`, …) |
| VI. Фронтенд | лише `components/ui` і токени; без нового polling; Realtime — наявний шов команди, нові стани (сегменти, H-публікація) мають відбиватися через уже підписані таблиці — перевіряється задачею T089; аналітика через типізований `analytics.track` |
| Міграції | кожна міграція має зворотні кроки в `supabase/migrations/ROLLBACK.md`; після міграцій — `npm run types:supabase` |
| Дизайн-система | нові стилі — утиліти від токенів, без нових правил у `launch-settings.css`; зміна `Choice.tsx` (PageUp/Down) — з оновленням `specs/021-design-system-redesign/contracts/components.md`, `/design`, `tests/design-components.test.tsx` |
| AGENTS.md: аналітика | нові ключі/коди в `analytics_properties_are_safe_v2`, `LAUNCH_ANALYTICS_CODES`, `TEAM_ERROR_CODES`, `scripts/analytics/code-map.ts`, `coverage-registry.ts` (research R17) |

Порушень немає. Повторна перевірка після аналізу: прибрано RPC без перевірки команди/актора (outputs_v2 → наявна per-set RPC), додано обов'язкове покриття аналітики.

## Project Structure

### Documentation (this feature)

```text
specs/062-multi-creative-launches/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/ (distribution.md, catalog-rows.md, rpc.md, ui.md)
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/shared/src/team/
├── launches.ts                          # LaunchCreative, creativeKind, константи
└── launches/
    ├── creative-distribution.ts         # НОВИЙ: розподіл копій і варіацій
    ├── validation.ts                    # parseLaunchConfig, коди відмов, нормалізація старих
    ├── persistence.ts                   # whitelist чернетки
    ├── preview.ts                       # перевірки типу/кількості, кампанії
    ├── naming.ts                        # alias+N
    └── catalog-video.ts                 # межі варіацій k..N

apps/web/src/team/launches/
├── LaunchCreativePicker.tsx             # кілька файлів, список
├── LaunchCreativeList.tsx               # НОВИЙ: рядки креативів
├── LaunchCreativeDistribution.tsx       # НОВИЙ: розподіл
├── LaunchEditor.tsx                     # підключення, приховування для зображень
├── LaunchCatalogVideoFields.tsx         # межі й підказка варіацій
├── LaunchSession.tsx, useLaunchGeneration.ts, LaunchBatch.tsx, картка/деталі
apps/web/src/team/product-catalog/       # менеджер каталогів: список креативів, приховані дії «одне джерело»
apps/web/src/team/ranks/creativeRanks.ts # без змін логіки (кредит у SQL)
apps/web/src/i18n*.ts                    # ключі

supabase/functions/
├── _shared/product-details.ts           # catalogIdPrefix, catalogProductId
├── _shared/product-catalog.ts           # planCatalogRows/buildProductCatalogRows за сегментами
├── _shared/catalog-image-rows.ts        # pictureImage kind 'creative'
├── _shared/catalog-drive-image-read.ts  # НОВИЙ: винесений readDrive
├── _shared/r2-catalog-images.ts         # ключі c1/
├── _shared/catalog-updater.ts           # префікс за _catalogRowCreatives
├── drive-ops/launches.ts, launch-catalog.ts, launch-catalog-video.ts, launch-batch.ts
├── drive-ops/catalog-video-generation.ts, catalog-initial-video-authority.ts
├── drive-ops/catalog-durable.ts         # крок creativeImages, сегменти
├── drive-ops/product-catalog.ts         # тип креативу, без пулу для зображень
├── drive-ops/creative-images.ts         # НОВИЙ: публікація зображень креативу
├── catalog-images/drive-sources.ts      # імпорт з _shared
├── catalog-images/worker.ts             # sweep c1/
└── catalog-updater/{claim-preparation,worker,nonvideo-writer}.ts

supabase/migrations/
├── 20261221100000_launch_multi_creative_config.sql     # save_launch_draft, sources, list, назви
├── 20261221110000_launch_catalog_video_segments.sql    # сегменти, обмеження наборів, accept/wait, retry сегмента
├── 20261221115000_catalog_image_creatives_invariants.sql # video_link nullable для зображень, гілки image в intent/context/accept
├── 20261221116000_catalog_publication_creatives_target.sql # ціль kind='creatives', сегменти цілі, відмови MULTI_CREATIVE_UNSUPPORTED
├── 20261221120000_launch_creative_images.sql           # зображення, uses, sweep, cron
├── 20261221130000_launch_multi_creative_ranks.sql      # ранги
├── 20261221140000_catalog_updater_multi_creative.sql   # перезашивка оновлювачем по сегментах, лінія публікації Z/H, відмови прихованих дій
└── 20261221150000_launch_multi_creative_analytics.sql  # whitelist analytics_properties_are_safe_v2

tests/
├── launch-creative-distribution.test.ts                # властивості SC-006
├── launch-multi-creative-config.test.ts
├── launch-creative-picker.test.tsx (розширити), launch-creative-distribution.test.tsx
├── catalog-multi-creative-rows.test.ts, catalog-product-id-prefix.test.ts
├── launch-creative-images.test.ts, catalog-updater-multi-creative.test.ts
├── launch-multi-creative-batch.test.ts
└── (pgTAP) supabase/tests/database/launch-multi-creative.test.sql
```

**Structure Decision**: наявне монорепо; нові файли лише там, де з'являється нова відповідальність (розподіл, список креативів, публікація зображень). Решта — розширення наявних модулів.

## Порядок робіт і ризики

1. **Фундамент shared** (типи, розподіл, валідація, нормалізація старих конфігурацій) — усе інше від нього залежить.
2. **SQL + edge для кількох відео** (сегменти, набори, рядки, префікс ID) → MVP: US1+US2+US3.
3. **Зображення** (публікація, рядки, оновлювач) → US4/US5.
4. **Пакет, назви, ранги, менеджер каталогів, розклад, оновлювач, аналітика** → US6.
5. **UI** йде паралельно з п.2–3 після п.1.

Ризики:
- Публічний origin бакета зображень після cutover 052 — перевірити першою задачею фази зображень; запасний шлях — маршрут Worker `/c/*`.
- Багато SQL-читачів одного набору — список у research R5; тест «один запуск — 4 набори» на кожен читач.
- Модель «одна ціль публікації на каталог» (R18): для k>1 і зображень — нова ціль `creatives`; кожен читач `t.kind` проходить аудит (T085); заміна відео, перевірка посилань, варіація посилань, оновлення картинок і ріст для неї відхиляються (R27), перезашивка й R2 працюють по сегментах (R28, R29).
- Колонка H у каталогу зображень має одного власника — лінію публікації (R30).
- Оновлювач повністю перезаписує snapshot (R20) — ключі креативів переносяться явно, тест двох оновлень поспіль.
- Пам'ять edge при оптимізації 16 МП зображень — послідовно, чекпойнт на кожне.
- Shared-зміни → повний релізний раннер на next; прод не чіпати.

## Complexity Tracking

Порушень конституції немає.
