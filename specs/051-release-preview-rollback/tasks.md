---
description: 'Tasks for 051 — next link, promote the tested build, rollback'
---

# Tasks: Тестова версія, розкатка перевіреного і відкат

**Input**: spec.md, plan.md, research.md, data-model.md, contracts/

**Tests**: потрібні. Спека вимагає доказів «ті самі байти» і відмов. Тести лежать у `tests/`, vitest працює single-worker.

## Phase 1: Setup

- [x] T001 Додати `PREVIEW_SITE_ORIGIN`, `PREVIEW_BRANCH`, `isSotySiteOrigin()` у `packages/shared/src/release.ts`, перезібрати `packages/shared/dist`
- [x] T002 [P] Додати `previewSiteOrigin`/`previewBranch` у production binding (`scripts/lib/release/bindings.mjs`) і перевірку непересічності для sandbox (`scripts/lib/release/targets.mjs`)

## Phase 2: Foundational

- [x] T003 Модуль стану каналу `scripts/lib/release-channel/state.mjs`: каталог (`SOTY_RELEASE_CHANNEL_DIR`), валідація схеми, атомарний запис, history.jsonl, архів бандлів з утриманням, lock через наявний `web-only-lock`
- [x] T004 Читання живого origin `scripts/lib/release-channel/live.mjs`: `index.html` + `stable.json` без кешу, без редіректів, з лімітом розміру
- [x] T005 [P] Тести стану: `tests/release-channel-state.test.ts`

## Phase 3: US1 — тестова версія за постійним посиланням (P1)

- [x] T006 [US1] `scripts/deploy-web.mjs`: `--channel=next` (за замовчуванням) деплоїть `--branch next`; бандл архівується в каталог стану; після успіху записується publish у стан; `--channel=production` дозволено лише з `SOTY_RELEASE_CHANNEL_TOKEN`
- [x] T007 [US1] `scripts/verify-live-smoke.mjs` і `verify-published-release` приймають `--channel=next`; `live_verify` у `scripts/lib/release/step-adapter.mjs` перевіряє next і що прод досі працює (FR-011)
- [x] T008 [P] [US1] Веб: `siteChannel()` і runtime `configuredSiteUrl()` у `apps/web/src/lib/config.ts`; same-origin маніфест у `apps/web/src/release-manifest.ts`
- [x] T009 [P] [US1] Веб: `NextChannelBadge` (позначка «Тестова версія · збірка N»), лише на next
- [x] T010 [US1] Міграція `release_testers` + функції; веб `ReleaseTesterGate` на next (fallback на `is_admin`); секція тестерів в адмінці
- [x] T011 [P] [US1] Тести: `tests/site-channel.test.ts`, `tests/release-testers.test.ts` (PGlite), `tests/release-tester-gate.test.tsx`, `tests/deploy-web-channel.test.ts`

## Phase 4: US2 — тестовий агент для тестерів (P1)

- [x] T012 [US2] Агент: preview origin в `allowedOrigins` для прод-конфігурації (`apps/agent/src/config.ts`); `/pair?origin=` (`apps/agent/src/server/app.ts`)
- [x] T013 [US2] Edge: `allowedBrowserOrigins` + preview для прод-сайту (`supabase/functions/_shared/cors.ts`); Drive callback повертає на збережений дозволений origin
- [x] T014 [P] [US2] Тести агента й CORS: `tests/agent-preview-origin.test.ts`, `tests/edge-cors-preview.test.ts`

## Phase 5: US3 — розкатка перевіреної збірки (P1)

- [x] T015 [US3] `operations.mjs promote`: перевірка стану, архіву, живого next; деплой тих самих байтів на прод через deploy-web з токеном; перевірка живого проду; live smoke; запис у стан; часткові результати = `uncertain` з підказкою
- [x] T016 [US3] CLI `scripts/release-channel.mjs` + npm-скрипт `release:channel`
- [x] T017 [P] [US3] Тести promote з інжектованими uploader/fetcher: `tests/release-channel-promote.test.ts`

## Phase 6: US4 — відкат однією дією (P1)

- [x] T018 [US4] `operations.mjs rollback`: `previous[0]` → прод, перевірка живого; `scripts/rollback-web.mjs` делегує сюди
- [x] T019 [US4] `adopt-live`: знайти в архівах бандл, що збігається з живим продом
- [x] T020 [US4] Веб: статус `ahead_of_stable` + пропозиція встановити стабільну в `ReleaseUpdateNotice`
- [x] T021 [P] [US4] Тести: `tests/release-channel-rollback.test.ts`, `tests/release-manifest-ahead.test.ts`

## Phase 7: US5 — міграції лише додають (P1)

- [x] T022 [US5] `scripts/check-migrations-additive.mjs` (`--base`), виняток `-- soty:cleanup`; гейт у `scripts/verify-all.mjs`
- [x] T023 [P] [US5] Тести: `tests/check-migrations-additive.test.ts`

## Phase 8: US6/US7 — скасування й стан (P2)

- [x] T024 [US6] `operations.mjs cancel`: production-бандл → next, `cancelled`
- [x] T025 [US7] `status` простою мовою + `--json`
- [x] T026 [P] Тести cancel/status

## Phase 9: Polish & зовнішнє налаштування

- [x] T027 Документація: `docs/RELEASE-CHANNEL.md` (для власника), `docs/PRODUCTION.md`, `AGENTS.md`
- [~] T028 Аналітика: history.jsonl і `status --json` — доказ операцій для агентів; окреме поле каналу в подіях — не додано (див. нотатки)
- [x] T029 Cloudflare: custom domain `next.soty.pp.ua` у `wishly-app` + CNAME на `next.wishly-app.pages.dev` (проксований)
- [x] T030 Supabase Auth: redirect URL `https://next.soty.pp.ua/**`; Google Cloud: referrer ключа Picker
- [ ] T031 Наживо: деплой збірки гілки на next, перевірка в Chrome (вхід, позначка, гейт), прод не змінився; `cancel` повертає next на прод
- [x] T032 `adopt-live --confirm` реєструє нинішній прод як ціль відкату
- [x] T034 [P] FR-020: перевірити, що наявне відновлення завантаження (`apps/web/index.html` boot recovery, `vite:preloadError` у `main.tsx`) покриває зміну бандла на тій самій адресі; тест або нотатка
- [x] T033 Lint, format, tsc web/agent, фокусні тести; повний suite single-worker

## Dependencies

T001 → усе. T003/T004 → T006, T015, T018, T024. T006 → T031. T029/T030 → T031. US3 → US4.

## Стан на 2026-11-11

- Зроблено й перевірено тестами: T001–T028, T032–T034. Нові тести: `release-channel`, `check-migrations-additive`, `release-preview-origins`, `release-testers-sql`, `release-next-ui`. Зачеплені наявні тести зелені.
- `adopt-live --confirm` виконано: прод 1.4.2 (бандл `001258f1925a`) записано як ціль відкату.
- **Не зроблено, бо заблоковано auto-режимом (зміни DNS, доменів і автентифікації), лишилось власнику:**
  - T029: custom domain `next.soty.pp.ua` у Pages-проєкті `wishly-app` + CNAME `next` → `next.wishly-app.pages.dev` (проксований);
  - T030: Supabase Auth Redirect URL `https://next.soty.pp.ua/**`; Google OAuth client — redirect URI `https://next.soty.pp.ua/auth/callback`; Picker API key — referrer `https://next.soty.pp.ua/*`.
- T031 (наживо) — після T029/T030 і першого релізу з цією фічею. Міграція, функції й агент приходять у прод разом із ним.
- FR-020: наявне відновлення (`vite:preloadError` у `main.tsx`, boot recovery в `index.html`) покриває зміну бандла на тій самій адресі. Розкатка, крім того, віддає вже завантажені на `next` ассети.
- Аналітика (частково): окремого поля «канал сайту» в подіях немає. Сесії кандидата відрізняються за `web_build_id` лише тоді, коли кандидат змінює версію (повний реліз). Веб-лише кандидата за подіями від проду не відрізнити. Додати поле — окрема зміна контракту подій, бо `events` валідує конверт.

### 2026-11-11, пізніше

- T029 і T030 виконано: custom domain через API Pages; CNAME `next`, Supabase redirect, Google OAuth redirect і referrer Picker — разом із власником у браузері. Google приймає `https://next.soty.pp.ua/auth/callback` (перевірено: вигадана адреса дає `signin/oauth/error`, next — ні).
- `next` зараз віддає прод 1.4.2 байт у байт (той самий `index.html`). Live smoke `--channel=next`: усе зелене, крім функцій (403). Функції отримають CORS для next з першим релізом, що містить 051.
