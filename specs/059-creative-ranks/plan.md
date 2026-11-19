# Implementation Plan: Ранги креативів (медові ліги)

**Branch**: `059-creative-ranks` (база `origin/beta` @ 62f40416, прод 1.5.7) | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/059-creative-ranks/spec.md`

## Summary

Кожне відео простору отримує медову лігу (Віск → Алмаз) і свіжість. Зарахування запусків роблять
тригери БД у транзакції успіху: перший `succeeded` генерації Launch і вставка каталогу напряму,
з поглинанням пари «каталог із Launch». Журнал `team_creative_launch_events` + проєкція
`team_creative_ranks`, бекфіл з історії. Веб читає ранги пачкою на сторінку провідника, показує
емблему (WebP 64/128) на плитці, у списку й у детальному перегляді. Власник простору може понизити ранг
з однією з двох причин. Пороги — одна веб-константа. Фіча — лише веб + бекенд: агент і `packages/shared`
не змінюються, тож іде швидким шляхом на next.

## Technical Context

**Language/Version**: TypeScript strict (ESM NodeNext), PL/pgSQL (PostgreSQL 17, Supabase)

**Primary Dependencies**: React 19 + HeroUI v3 design system (`apps/web/src/components/ui`), Supabase JS, realtime через `team_catalog_events`

**Storage**: дві нові таблиці (журнал, проєкція), переозначення `team_catalog_events_kind_check`

**Testing**: pgTAP (`supabase/tests/database/creative-ranks.test.sql`), vitest single-worker (`tests/*.test.ts(x)`), ручний смок на беті через Playwright-драйвер

**Target Platform**: веб (Chrome/Safari/Edge, macOS + Windows), сервер Supabase

**Project Type**: web app + database

**Performance Goals**: один RPC на сторінку провідника (≤ 100 id), ≤ 10 % до часу відкриття сторінки з 200 плитками; оновлення рангу в іншому вікні ≤ 5 с

**Constraints**: зарахування не може зламати публікацію Launch чи створення каталогу; бізнес-помилки PT409/42501, не 40001; токени design system; без змін `packages/shared` і агента; машина — один важкий процес

**Scale/Scope**: 19 просторів, сотні відео на простір, пачки до 100 Launch

## Constitution Check

| Принцип                  | Як дотримано                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Type-safe contracts   | Відповіді RPC — `unknown` → `parseCreativeRankList` з discriminated result; стани ліг/свіжості — string-literal unions                                                                       |
| II. Release contract     | `release.ts`, `packages/shared`, агент не змінюються; міграція адитивна; веб-деплой швидким шляхом next                                                                                      |
| III. Least privilege     | RLS + `revoke all` на обох таблицях; лише security-definer RPC з `search_path=''`; owner через `private.team_role`; analytics RO — лише `select`; ключі аналітики — закритий перелік у guard |
| IV. Child processes      | Не зачіпається (лише одноразова конвертація асетів `cwebp` під час розробки)                                                                                                                 |
| V. HTTP/errors           | Коди `PERMISSION_DENIED`/42501, `RANK_CONFLICT`/`RANK_NOT_LOWER`/PT409, `INVALID_INPUT`/22023                                                                                                |
| VI. Frontend composition | Компоненти з `components/ui`, токени з `tokens.css`, слот у `MaterialDetail`, пакетне читання за зразком restitch prep                                                                       |
| Gates                    | pgTAP + vitest локально single-worker; `npm run verify` лише коли машина вільна                                                                                                              |

Порушень немає; Complexity Tracking порожній.

## Project Structure

### Documentation (this feature)

```text
specs/059-creative-ranks/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md
├── contracts/rpc.md, contracts/ui.md
├── checklists/requirements.md
└── tasks.md            # speckit-tasks
```

### Source Code

```text
supabase/migrations/20261218200000_creative_ranks.sql                 # таблиці, тригери, RPC, бекфіл, realtime kind
supabase/tests/database/creative-ranks.test.sql

apps/web/public/creative-ranks/*.webp                          # 30 файлів (готові)
apps/web/src/team/ranks/
├── creativeRanks.ts        # пороги, leagueOf, freshnessOf, demotionTarget, парсер
├── RankEmblem.tsx, RankFacts.tsx, MaterialRank.tsx
├── useCreativeRanks.ts
└── analytics.ts            # seam подій
apps/web/src/api/team.ts                       # listCreativeRanks, demoteCreativeRank
apps/web/src/team/catalogEventDomains.ts       # 'creative_rank' → 'ranks'
apps/web/src/team/useTeamRealtime.ts, TeamContext.tsx   # домен і ranksRevision
apps/web/src/team/explorer/ExplorerShell.tsx, ContentGrid.tsx, ContentList.tsx, PreviewPane.tsx
apps/web/src/team/materials/MaterialDetail.tsx  # слот rank
apps/web/src/styles/tokens.css, styles.css      # розміри емблеми, позиція
apps/web/src/locales/*                          # тексти uk/en
apps/web/src/analytics/events.ts               # три події, наявні ключі
apps/web/src/lib/database.types.ts              # нові RPC
scripts/analytics/coverage-registry.ts, scripts/analytics/creative-ranks.ts, cli.ts
tests/creative-ranks.test.ts, tests/creative-rank-ui.test.tsx
```

**Structure Decision**: наявна структура web app + Supabase; новий модуль `apps/web/src/team/ranks/`.

## Phases

1. **БД** — міграція (R1–R5, R8, R9), pgTAP, накат на бету через psql + `schema_migrations`.
2. **Веб-ядро** — константи/парсер/API/realtime-домен + unit-тести.
3. **US1** — плитка й список (емблема, факти), пакетне читання.
4. **US3** — детальний перегляд і пониження.
5. **Аналітика** — події (наявні ключі, без guard-міграції), coverage registry, CLI `creative-rank`.
6. **Перевірка** — смок на беті за quickstart, фікси, `npm run verify` коли машина вільна, коміт і пуш гілки.
   Деплой на next — окремим рішенням власника.

## Complexity Tracking

Порожньо.
