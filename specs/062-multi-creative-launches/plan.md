# Implementation Plan: Кілька креативів і зображення в каталожних запусках

**Branch**: `062-multi-creative-launches` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/062-multi-creative-launches/spec.md`

## Summary

Каталожний запуск приймає до 10 креативів одного типу. Відео: кожне — окремий сегмент суцільних рядків і, з перезашивкою, власний набір `catalog_video_sets`; варіації роздаються по колу. Зображення: публікуються в R2 (`c1/…`) з анонімною перевіркою й стають `image_link` своїх рядків замість білих; відеоколонок і перезашивки немає. ID кожного нового товару починається з назви креативу. Розподіл копій — чиста shared-функція з повзунками й полями в редакторі. Конфігурація зберігає список креативів і дзеркалить перший у старі поля, тому десятки SQL-читачів `config->>'materialId'` лишаються правильними без змін. Агент не змінюється: фоновий виконавець і так бере набори по одному.

## Technical Context

**Language/Version**: TypeScript 5 strict (NodeNext ESM), Deno для Supabase Edge Functions, PostgreSQL 17 (PL/pgSQL)

**Primary Dependencies**: React + HeroUI v3 (через `apps/web/src/components/ui/`), Supabase (RLS, RPC, Realtime, pg_cron), Cloudflare R2 (S3 API), Google Drive API

**Storage**: Postgres (`team_launches.draft_config`, `team_launch_revisions.config` jsonb; нові `private.launch_catalog_video_segments`, `private.launch_creative_images`, `private.launch_creative_image_uses`), R2 публічний бакет зображень каталогу, Google Sheets (каталог)

**Testing**: vitest single-worker (`--pool=forks --poolOptions.forks.singleFork=true`), pgTAP/SQL-тести в rolled-back транзакції на беті, Playwright-драйвер на беті для приймання UI

**Target Platform**: веб (Chrome/Safari desktop), Supabase Edge, агент macOS M-серії/Intel і Windows — без змін коду агента

**Project Type**: монорепо web + shared + edge functions + agent

**Performance Goals**: публікація ≤ 10 зображень ≤ 50 МБ у межах одного-двох викликів функції з чекпойнтом на зображення; розподіл у UI — миттєвий (< 16 мс на зміну при k=10)

**Constraints**: N ≤ 400, k ≤ 10; старі запуски/каталоги без міграції даних; нові таблиці з RLS і `task_cleanup_reference_fence`; без нових секретів; прод не чіпати (реліз лише на next)

**Scale/Scope**: ~24 акаунти, 19 просторів; зміни в ~40 файлах web/shared/edge, 4–5 міграцій

## Constitution Check

| Принцип | Як дотримано |
|---|---|
| I. Типи й валідація на межі | `LaunchCreative`, коди відмов — дискримінований результат `parseLaunchConfig`; межі (`LAUNCH_CREATIVES_MAX`, `CATALOG_ID_PREFIX_MAX`) — константи shared; edge розбирає `segments` як `unknown` |
| II. Єдине джерело релізу | версії/протокол не змінюються; `AGENT_API_VERSION` без змін; shared `dist` перебудовується перед перевірками |
| III. Безпека | нові таблиці `private.*`, RLS + `revoke all`, RPC `security definer` + `search_path=''`; Drive-докази перед читанням зображення; анонімна перевірка публічного читання; без секретів у треканих файлах |
| IV. Дочірні процеси | агент не змінюється |
| V. Помилки | стабільні машинні коди (`CREATIVES_MIXED`, …) |
| VI. Фронтенд | лише `components/ui` і токени; без нового polling; Realtime-шви без змін; аналітика через типізований `analytics.track` |
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
├── 20261220100000_launch_multi_creative_config.sql     # save_launch_draft, sources, list, назви
├── 20261220110000_launch_catalog_video_segments.sql    # сегменти, обмеження наборів, accept/wait, retry сегмента
├── 20261220115000_catalog_image_creatives_invariants.sql # video_link nullable для зображень, гілки image в intent/context/accept
├── 20261220116000_catalog_publication_creatives_target.sql # ціль kind='creatives', сегменти цілі, відмови MULTI_CREATIVE_UNSUPPORTED
├── 20261220120000_launch_creative_images.sql           # зображення, uses, sweep, cron
├── 20261220130000_launch_multi_creative_ranks.sql      # ранги
├── 20261220140000_catalog_growth_by_creative.sql       # ріст за сегментами
└── 20261220150000_launch_multi_creative_analytics.sql  # whitelist analytics_properties_are_safe_v2

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
4. **Пакет, назви, ранги, ріст, аналітика** → US6.
5. **UI** йде паралельно з п.2–3 після п.1.

Ризики:
- Публічний origin бакета зображень після cutover 052 — перевірити першою задачею фази зображень; запасний шлях — маршрут Worker `/c/*`.
- Багато SQL-читачів одного набору — список у research R5; тест «один запуск — 4 набори» на кожен читач.
- Модель «одна ціль публікації на каталог» (R18): для k>1 і зображень — нова ціль `creatives`; заміна відео, перевірка посилань, R2-перевипуск і перезашивка оновлювачем для них свідомо відхиляються.
- Оновлювач повністю перезаписує snapshot (R20) — ключі креативів переносяться явно, тест двох оновлень поспіль.
- Пам'ять edge при оптимізації 16 МП зображень — послідовно, чекпойнт на кожне.
- Shared-зміни → повний релізний раннер на next; прод не чіпати.

## Complexity Tracking

Порушень конституції немає.
