# Validation log: 050 опційна публікація відео каталогу в R2

Живий журнал реалізації. Факти, не наміри. Оновлюється по ходу задач T001–T038.

## T001 — стан на старті (2026-11-10)

- **Робоча копія**: worktree `/Users/daynero/RiderProjects/AffSupport-050-video-r2`, гілка `050-catalog-video-r2` від `main` `563d8351` (спека `a71d3ad1` уже в `main`/`origin/main`). Спільну робочу копію `main` (релізна сесія 1.4.0) не перемикаємо; stash 048 і worktree `AffSupport-048-trust` належать іншій сесії — не чіпати.
- **Слот міграції**: `20261207193000_catalog_video_r2.sql`; останній наявний — `20261207190000_agent_native_identity_analytics.sql`. Повторно перевірити перед T007 і перед релізом (релізна сесія може додати міграції).
- **Environment-входи edge-функції `catalog-video-r2`** (нічого з цього не записується в репозиторій):
  - нові: `CATALOG_VIDEOS_ENABLED` (лише точне `true`), `R2_CATALOG_VIDEO_STAGING_BUCKET` = `soty-catalog-videos-<environment>-staging`, `R2_CATALOG_VIDEO_PUBLIC_BUCKET` = `soty-catalog-videos-<environment>-public`, `R2_CATALOG_VIDEO_PUBLIC_ORIGIN` (окремий HTTPS-домен без шляху), `R2_CATALOG_VIDEO_TARGET_CONFIRMATION` = `<environment>:<accountId>:<staging>:<public>:<origin>`, `R2_CATALOG_VIDEO_ACCESS_KEY_ID`, `R2_CATALOG_VIDEO_SECRET_ACCESS_KEY` (пара, обмежена двома відео-bucket), необов'язково `CATALOG_VIDEOS_PART_VERIFICATION` = `readback` (за замовчуванням) | `provider_checksum` (лише після доказу T003);
  - спільні з 045: `CATALOG_IMAGES_ENVIRONMENT`, `R2_CATALOG_ACCOUNT_ID`, `R2_CATALOG_ZONE_ID`, `R2_CATALOG_PURGE_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `DRIVE_OAUTH_MODE`, `WISHLY_SITE_URL`;
  - секрет воркера: чинний `CATALOG_SYNC_SECRET` у середовищі функції = vault `wishly_catalog_sync_secret`; заголовок `x-catalog-sync-secret`; нових секретів немає.
- **Залежність від 045**: конфіг картинок не потрібен для роботи відео (окрема пара bucket), але середовище й зона спільні.
- **Реліз**: повний (R13), серверна частина на прод лише через `npm run release:backend-plan` → `npm run release:backend-apply` (R13, plan Release Plan A). Provisioning у production не запускається з цієї гілки.

## T003 — пісочниця R2 (стан: заблоковано відсутністю креденшелів)

- У локальних env-файлах (`.env.beta`, `config/keys/*.env`, `supabase/.env*`) немає жодного `R2_CATALOG_*`. Пісочницю multipart і доказ поведінки `x-amz-checksum-sha256` на `UploadPart` локально запустити неможливо.
- Рішення: адаптер реалізує **обидві** стратегії (`provider_checksum`, `readback`); за замовчуванням `readback` (Range-readback частини зі staging і власна звірка SHA-256), бо він не залежить від недоведеної поведінки провайдера. Перемикач — env `CATALOG_VIDEOS_PART_VERIFICATION`. Застосована стратегія пишеться в `parts.verified_by` і в журнал (`part_verification`).
- Що треба довести, коли з'являться креденшели бети (власник): (1) `UploadPart` з навмисно невірним `x-amz-checksum-sha256` відхиляється (очікувано `400 BadDigest`/`InvalidRequest`); (2) з вірним — приймається й `ETag` повертається; (3) `CompleteMultipartUpload` збирає об'єкт і публічний `HEAD` дає `content-length` = сума частин; (4) `AbortMultipartUpload` прибирає незавершений upload; (5) CPU/wall на одну частину 16 МіБ (потокове читання + SHA-256) у edge-рантаймі. Сценарій — `specs/050-catalog-video-r2/provider-acceptance.ts` (T035).
- `supabase/config.toml`: додано `[functions.catalog-video-r2] verify_jwt=false` (той самий механізм, що `catalog-images`: user-маршрути перевіряють JWT у handler, воркер — лише названий секрет).
- `supabase/functions/catalog-video-r2/deno.json`: ті самі версії `aws4fetch@1.0.20` і `@supabase/supabase-js@2.110.7`, що в `catalog-images`.

## Реалізація (2026-11-10) — що зроблено і чим доведено

Усе у worktree `AffSupport-050-video-r2`, гілка `050-catalog-video-r2`, незакомічено. Машина спільна з релізною сесією 1.4.0: усі важкі перевірки по одній, `uptime` перед кожною, vitest лише `--pool=forks --poolOptions.forks.singleFork=true`; `npm run verify` і бета не запускались.

| Шар | Файли | Доказ |
|---|---|---|
| Shared контракт | `packages/shared/src/team/catalog-video-r2.ts`, `transport.ts` (+16 кодів), `launches.ts`/`launches/validation.ts` (`copyVideoToR2`) | `tests/catalog-video-r2-contract.test.ts` — 7 pass |
| Міграція | `supabase/migrations/20261207193000_catalog_video_r2.sql` (8 private таблиць, публічні сигнали, nullable `link_kind` у квитанції, заміна `service_record_catalog_publication_link` з default, RPC, тригери-надгробки, інвокатор + 2 cron, 4 analytics-view) | `tests/catalog-video-r2-schema.test.ts` — 11 pass на PGlite з усіма міграціями; `supabase/tests/database/catalog-video-r2.test.sql` написано (pgTAP, потребує Docker-БД) |
| Адаптер R2 | `_shared/r2-catalog-video.ts`, `_shared/md5.ts` | `tests/catalog-video-r2-adapter.test.ts` — 7 pass (in-memory S3 + CDN) |
| Резолвер | `_shared/catalog-video-link.ts` | `tests/catalog-video-link-resolver.test.ts` — 8 pass |
| Воркер/handler/entry | `catalog-video-r2/{worker,handler,index}.ts` | `catalog-video-r2-worker.test.ts` — 8 pass; `catalog-video-r2-handler.test.ts` — 4 pass |
| Підключення (5 місць) | `product-catalog.ts`, `catalog-initial-video-authority.ts`, `publication-io.ts`, `updater-variants.ts`, `catalog-updater/worker.ts` (+ `index.ts` обох функцій, `launch-catalog.ts`, `drive-ops/index.ts`) | `catalog-video-r2-create.test.ts` — 4 pass; регресія 11 наявних файлів (124 тести) pass |
| Web | `api/team-catalog-video-r2.ts`, `CatalogVideoR2Toggle.tsx`, `CatalogVideoR2UsageSection.tsx`, діалог створення, `LaunchEditor`, `LaunchDefaultsReview`, `CatalogProfileEditor`, `CatalogUpdaterDialog`, `useTeamRealtime`, `SpaceSettings`, локалі, `errors.ts` | `catalog-video-r2-ui.test.tsx` — 5 pass; регресія 15 web-файлів (267 тестів) pass після оновлення очікування Realtime-таблиць |
| Політика | `pages/legal-content.ts` (uk/en), `docs/NO_SERVER_MEDIA_PLAN.md`, `docs/CATALOG_VIDEO_R2.md` | `catalog-video-r2-policy.test.ts` — 3 pass |
| Діагностика | `scripts/analytics/catalog-video-r2.ts`, `cli.ts`, `investigate.ts`, `schema.ts`, `types.ts`, `code-map.ts`, `docs/ANALYTICS_CLI.md` | `catalog-video-r2-diagnostics.test.ts` — 4 pass; `analytics-code-map.test.ts` — 21 pass |

Типізація: `tsc -p tsconfig.check.json`, `tsc -b apps/web`, `tsc -p tsconfig.scripts.json` — без помилок; `eslint` по всіх змінених файлах — без зауважень. Deno локально немає: entrypoint-и `index.ts` перевірені лише через vitest-імпорти handler/worker; `deno check` — на беті.

Поведінкові рішення, прийняті під час реалізації (не суперечать спеці, уточнюють її):

- Створення з галочкою ставить копію в чергу відразу після реєстрації каталогу (`apply_create_option` + `resolve_current`), але перший запис клітинки лишається Drive, якщо копія ще не готова; R2 з'являється при наступному оновленні (FR-006, US2.1). Для створення через відео-протокол (publication job) резолвер працює у pre-creation scope, тож готова спільна копія може дати R2 уже в першому job.
- Multipart іде у приватний staging-bucket; після `CompleteMultipartUpload` частини читаються назад зі staging (стратегія `readback`), потім `CopyObject` у публічний bucket, HEAD + Range-проби, видалення staging. Так жоден неперевірений байт не стає публічним.
- `confirm_use` для каталогу без рядка опції і без uses — no-op: каталоги без галочки не отримують ні журналу, ні сигналів (SC-001).
- Застарілий шлях оновлення (без publication job) резолвить через `resolve_current` з проіндексованого рядка матеріалу; `current_video_link`/`shared_link` лишаються Drive.

## Регресія 2026-11-10

- `tests/catalog-*` + `tests/product-catalog*`: 169 файлів, 1573 тести — pass.
- `tests/launch-*` + `tests/team-*` + `tests/analytics-*`: 303 файли, 2868 тестів — pass після двох правок, яких вимагали наявні гейти: (1) `tests/analytics-investigate-command.test.ts` — очікуваний список сліпих зон `investigate` доповнено п'ятьма зонами `catalog-video-r2`; (2) контракт кодів помилок — нові `VIDEO_R2_*` коди мають власну додаткову міграцію `supabase/migrations/20261207194000_catalog_video_r2_error_codes.sql`, згенеровану `scripts/generate-team-contract-sql.mjs` (новий `--video-extension-output`); `node scripts/generate-team-contract-sql.mjs --check` — current; `tests/team-contract.test.ts` перевіряє дельту і forward-upgrade на PGlite.
- Разом із 10 новими файлами фічі: усе зелено; `npm run verify` повністю не запускався (машина спільна з релізом 1.4.0).
