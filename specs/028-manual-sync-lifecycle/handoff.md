# Промт для агента: випустити фічу 028 у production

Ти працюєш у репозиторії `/Users/daynero/RiderProjects/AffSupport`. Спершу прочитай
`AGENTS.md` і `CLAUDE.md`, потім `specs/028-manual-sync-lifecycle/quickstart.md`
(розділи «Evidence» і «Після релізу D») та `docs/incidents/2026-10-07-folder-sync-diagnosis-and-plan.md`.

## Що вже зроблено (не повторювати)

- Фіча 028 «надійний життєвий цикл ручної синхронізації Drive-папки» повністю реалізована
  і закомічена: коміт `d873daab` у гілці `028-manual-sync-lifecycle` (від `c4ee7eb5` = `main` = 1.2.5).
- Усе перевірено локально (218 тестів у 26 файлах, tsc, eslint, prettier, перевірки
  дизайн-токенів) і на локальній беті: чотири міграції застосовані через
  `supabase migration up --local`, справжній worker відпрацював виправлений життєвий цикл.
- `npm run release:backend-plan -- --json` з цього коміту дає 17 змін: міграції
  `20261008100000`, `20261008110000`, `20261015100000`, `20261022100000` (усі `before-web`,
  `compatibleWithPrevious: true`) і передеплой 13 edge-функцій (змінився `_shared/drive.ts`).
- `packages/shared` і `apps/agent` не змінювались — це web-only реліз, повний раннер із
  пакуванням агентів не потрібен.

## Що треба зробити (саме це я не можу без доступу до production)

1. **Гілка і CI.** Запушити `028-manual-sync-lifecycle`, відкрити PR у `main`, дочекатись
   зеленого `verify` на macOS/Windows/Linux (CI запускає і pgTAP-сюїти `supabase/tests/database/sync-*.test.sql`,
   які локально не запускались — немає локального Supabase CLI-стенду для pgTAP).
   `npm run verify` на цій машині не запускати: вона слабка, verify іде лише в CI.
   Якщо падає `tests/team-batch-queue.test.tsx` — це відомий flake під навантаженням, не з цієї фічі.
2. **Backend у production** за чинним runbook: `npm run release:backend-plan`, перевірити, що
   план містить рівно чотири міграції 028 і функцію `catalog-sync`, потім
   `npm run release:backend-apply`. Міграції additive; відкат описаний у
   `supabase/migrations/ROLLBACK.md` (чотири розділи 2026100810…/2026102210…).
   Нічого не скидати і не перезаливати руками.
3. **Веб у production**: web-only deploy за runbook (`deploy:web` ланцюжок:
   verify-web-env → build:web → verify-release --deploy → verify-published-release → wrangler).
   Пам'ятай про отруєння кешу модулів Cloudflare після деплою
   (`docs`/пам'ять: `cloudflare-deploy-poisons-module-cache`) — перевір, що нові чанки доїхали.
4. **Після деплою**: `npm run types:supabase` (працює лише `--linked`), закомітити оновлений
   `apps/web/src/lib/database.types.ts` (я дописав туди п'ять RPC руками; регенерація їх замінить).
5. **Знімок інциденту (T042), до 2026-10-14**: `npm run analytics -- sync <email власника простору>
   --json`, результат (без секретів — команда їх і не віддає) записати в
   `docs/incidents/2026-10-07-folder-sync-diagnosis-and-plan.md`, розділ «Крок 1»: у якому стані
   був canonical job у момент першого кліку — `failed` (і з яким `error_code`), `retry`, чи
   прострочений lease. Якщо завершені jobs уже стерті retention-ом (7 днів), так і записати.
6. **Спостереження 24 години** після релізу (список у `quickstart.md`, «Після релізу D»):
   waiters старші за 10 хв без `blocked`-причини, розподіл `last_error_code`,
   `lease_lost`/`NO_PROGRESS` у логах worker-а, p95 request→claim, частка outcome
   `disconnected`/`unreachable`. `ACTIVE` функція і HTTP 200 без корисного поступу — не успіх.
7. **Реальний Drive на беті або проді (quickstart §2 п.1–8 з двома акаунтами)**: у локальній беті
   Google Drive не підключений, OAuth-згоду може дати лише власник. Пройти 20 послідовних
   синхронізацій одним акаунтом без участі другого, ярлик у папці, папку без доступу, і
   переконатися, що обидва акаунти бачать результат. Записати в `quickstart.md`.

## Обмеження

- У робочій копії є чужі незакомічені зміни іншої сесії (release-controller:
  `package.json`, `scripts/lib/release/*`, `scripts/release-runner.mjs`, `scripts/release-worker.mjs`,
  `apps/web/src/release-panel/`, `packages/shared/src/release-automation.ts` та інші).
  Їх не чіпати і в коміти 028 не брати.
- На беті ніколи не робити `supabase db reset`; міграції лише `migration up --local`.
  Edge runtime беті може бути зупинений (`docker ps` без `supabase_edge_runtime_wishly`) —
  `docker start supabase_edge_runtime_wishly`.
- Перед будь-яким tsc/vitest — `uptime` (load < 6) і `pgrep -fl "vitest|tsc|vite"`; vitest лише
  `--pool=forks --poolOptions.forks.singleFork=true`, по одному файлу.
- Нічого в production не змінювати поза runbook; секрети нікуди не писати і не друкувати.

## Критерій готовності

PR змерджено, backend-apply і web deploy пройшли з зеленою live-перевіркою, `database.types.ts`
регенеровано, знімок інциденту записано, 24-годинні метрики без waiters у «виконується» понад
10 хвилин без причини, двохакаунтний прогін на реальному Drive записано в `quickstart.md`.
