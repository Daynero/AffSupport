# Tasks: Ранги креативів (медові ліги)

**Input**: `specs/059-creative-ranks/` — spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md
**Tests**: так — pgTAP і vitest вимагає quickstart; vitest лише single-worker, перед кожним запуском `uptime`.

## Phase 1: Setup

- [x] T001 Створити воркдерево `AffSupport-059`, гілку `059-creative-ranks` від `origin/beta` і склонувати залежності
- [x] T002 [P] Конвертувати 15 емблем у WebP 64/128 px в `apps/web/public/creative-ranks/`

## Phase 2: Foundational (БД і веб-ядро — блокує всі історії)

- [x] T003 Міграція `supabase/migrations/<next>_creative_ranks.sql`: таблиці `team_creative_launch_events` і `team_creative_ranks` (data-model.md), RLS + `revoke all`, `grant select` для `wishly_analytics_ro`
- [x] T004 У тій самій міграції: `private.apply_creative_rank_event(...)` з поглинанням (research R3) і подією `team_catalog_events('creative_rank')`; переозначити `team_catalog_events_kind_check` з новим видом
- [x] T005 У тій самій міграції: deferred-тригери `private.credit_launch_rank()` на `team_launch_generations` (R1) і `private.credit_catalog_rank()` на `team_product_catalogs` (R2); жодного винятку назовні
- [x] T006 У тій самій міграції: RPC `public.list_creative_ranks` і `public.demote_creative_rank` за `contracts/rpc.md` (коди 42501/PT409/22023)
- [x] T007 У тій самій міграції: ідемпотентний бекфіл (R5)
- [x] T008 pgTAP `supabase/tests/database/creative-ranks.test.sql`: усі пункти quickstart §1
- [x] T009 [P] `apps/web/src/team/ranks/creativeRanks.ts`: пороги, `leagueOf`, `freshnessOf`, `demotionTarget`, `emblemSrc`, `parseCreativeRankList` (contracts/ui.md)
- [x] T010 [P] `tests/creative-ranks.test.ts`: межі ліг/свіжості, пониження, парсер
- [x] T011 `apps/web/src/api/team.ts` + `apps/web/src/lib/database.types.ts`: `listCreativeRanks`, `demoteCreativeRank` з розбором помилок
- [x] T012 Realtime: `'creative_rank'` → домен `ranks` у `apps/web/src/team/catalogEventDomains.ts` і `useTeamRealtime.ts`; `ranksRevision` у `apps/web/src/team/TeamContext.tsx`

## Phase 3: US1 + US2 — ліги в провіднику, ріст від запусків (P1) 🎯 MVP

**Goal**: на плитках і в списку видно лігу, свіжість і `N× · давність`, оновлення в реальному часі.
**Independent Test**: quickstart §3 кроки 1–4.

- [x] T013 [P] [US1] `apps/web/src/team/ranks/RankEmblem.tsx` і `RankFacts.tsx`; токени `--rank-emblem-*` у `apps/web/src/styles/tokens.css`
- [x] T014 [US1] `apps/web/src/team/ranks/useCreativeRanks.ts`: пачка на сторінку, `ranksRevision`, нейтральний стан при помилці
- [x] T015 [US1] Плитка (лише відео): емблема в правому нижньому куті `.team-explorer-tile-badge-layer`, факти в `.team-explorer-tile-facts` — `apps/web/src/team/explorer/ContentGrid.tsx`, `ExplorerShell.tsx`, `apps/web/src/styles.css`
- [x] T016 [US1] Список: емблема 20 px біля `TagDot` — `apps/web/src/team/explorer/ContentList.tsx`
- [x] T017 [P] [US1] Тексти uk/en у `apps/web/src/locales/`
- [x] T018 [US1] `tests/creative-rank-ui.test.tsx`: плитка з рангом, без рядка (Віск), з помилкою читання

## Phase 4: US3 — детальний перегляд і пониження (P2)

**Goal**: велика емблема, факти, пониження власником з причиною.
**Independent Test**: quickstart §3 кроки 5–6.

- [x] T019 [US3] `apps/web/src/team/ranks/MaterialRank.tsx` (DropdownMenu з двома причинами, конфлікт → актуальний стан)
- [x] T020 [US3] Слот `rank` у `apps/web/src/team/materials/MaterialDetail.tsx` і передача в `apps/web/src/team/explorer/PreviewPane.tsx`
- [x] T021 [US3] Тести owner/editor і конфлікту в `tests/creative-rank-ui.test.tsx`

## Phase 5: US4 — ранги з першого дня (P2)

- [x] T022 [US4] Накат міграції на бету через psql + `schema_migrations`; звірити лічильники простору Goor з ручним SQL-перерахунком

## Phase 6: Аналітика і діагностика

- [x] T023 [P] Події `creative_rank_demote_started|finished`, `creative_rank_read_failed` у `apps/web/src/analytics/events.ts`; seam `apps/web/src/team/ranks/analytics.ts`; виклики в T014/T019
- [x] T024 Guard аналітики не змінюється: події використовують наявні ключі (research R10)
- [x] T025 [P] `scripts/analytics/coverage-registry.ts`: capabilities `creative_rank_demote`, `creative_rank_credit`
- [x] T026 CLI `npm run analytics -- creative-rank` у `scripts/analytics/creative-ranks.ts` + реєстрація в `cli.ts`; тест у `tests/`

## Phase 7: Polish

- [ ] T027 `node scripts/check-design-tokens.mjs`, `check-tailwind-classes.mjs`, `verify-styles.mjs`, lint, typecheck веба
- [ ] T028 Смок на беті за quickstart §3 (обидві теми, вузьке вікно), фікси
- [ ] T029 `npm run verify`, коли машина вільна; коміт і пуш гілки `059-creative-ranks`

## Dependencies

T003–T007 → T008, T011 → T014 → T015/T016 → T018; T009 → T013/T014/T019; T012 → T014; T019 → T020 → T021;
T003–T007 → T022; T023 → T024; усе → T027 → T028 → T029.
MVP = Phase 2 + Phase 3. US3 і аналітика незалежні між собою після Phase 2.

## Parallel

T009/T010 паралельно з міграцією (T003–T007); T013/T017 паралельно; T023/T025 паралельно.
Важкі процеси (pgTAP, vitest, tsc) — строго по одному.
