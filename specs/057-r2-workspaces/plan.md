# План імплементації: простори Soty на R2

**Гілка**: `057-r2-workspaces` (від `origin/beta` = прод 1.7.2) | **Дата**: 2026-11-27 |
**Специфікація**: [spec.md](spec.md)
**Вхід**: специфікація в редакції 2026-11-27 (US1–US11, FR-001–FR-061, SC-001–SC-017) і рішення
власника та ведучого від 2026-11-27. Лише документи: коду, міграцій, деплоїв і записів у бази
чи bucket у цьому кроці немає.

## Підсумок

Новий простір живе в R2, а не в Google Drive. Soty — єдине джерело істини. Байти йдуть
напряму між клієнтом і R2. Мініатюри й метадані Soty робить сама при фіксації, а зміни
приходять через Realtime. Пам'ять простору видно на шкалі з категоріями. Видалення
звільняє місце одразу й не лишає сиріт.

Переносу старих просторів немає. Старий Drive-простір 60 діб після T0 працює як сьогодні,
потім одним серверним правилом стає архівом.

Порядок робіт — три етапи:

- **M1.** Власник сам працює в R2-просторі на next. Решта користувачів, прод і Drive-простори
  цього не помічають.
- **M2.** Входи без Drive і доказ швидкості проти Drive-бази.
- **M3.** Умови загального запуску: архів старих просторів, місткість у тарифі 034, резерв,
  діагностика, повний реліз.

Головне технічне рішення: R2-матеріал — рядок тієї самої `team_materials` з nullable
Drive-полями, а не таблиці-двійники ([research.md](research.md) R1). Тому завдання, каталоги,
запуски, пошук і зв'язки працюють без паралельних моделей. Ізоляцію від старих клієнтів дає
межа на рівні простору (R6).

## Технічний контекст

- **Мова й версії.** Наявні: TypeScript strict/ESM (NodeNext, `.js` в імпортах), Node ≥22.12 <25,
  Deno для Supabase Functions, SQL PostgreSQL 17. Нових мов і фреймворків немає. Container
  похідних — Node + ffmpeg + libvips у Docker-образі.
- **Залежності.** Наявні: React/Vite + HeroUI v3 (через `apps/web/src/components/ui/`),
  Supabase Auth/Postgres/RLS/Realtime, `aws4fetch@1.0.20` для підпису S3 (уже в
  `supabase/functions/catalog-video-r2/index.ts:56-62`), Cloudflare Workers (`apps/catalog-image-delivery`).
  - Нові з Cloudflare: bucket `soty-spaces-{env}`, Queue `space-derivatives-{env}`,
    Container, маршрут `files[-beta].soty.pp.ua`, правило кешу `/feeds/*`.
  - Хешування у вебі — `crypto.subtle` не вміє інкрементально, тож потрібна бібліотека
    SHA-256 у Web Worker. Версію закріпити під час імплементації.
- **Сховище.**
  - Метадані — наявна Supabase.
  - Байти простору — приватний R2 `soty-spaces-{env}`, EU jurisdiction (перевірити readback, T001).
  - Стрічки каталогів — наявний публічний `soty-catalog-videos-{env}-public`.
  - Резерв (M3) — Backblaze B2 US East.
- **Тестування.**
  - Vitest у корені `tests/` — лише цільові файли, один процес.
  - pgTAP у `supabase/tests/database/*.test.sql` — через `npm run test:db`.
  - Контрактні тести провайдера — на beta-bucket.
  - Сценарії браузера й агента — на беті, потім на next.
  - Повний гейт — `npm run verify` у CI. Локально не запускати.
- **Платформи.** Веб (настільний і мобільний браузер, PWA share target). Агент на macOS
  arm64/x64 і Windows x64. Сервер — Supabase Edge і Cloudflare.
- **Тип проєкту.** Наявний монорепозиторій плюс один новий застосунок
  `apps/space-derivatives/` (Queue-споживач і Container).
- **Цілі швидкості.**
  - SC-011 — умова M2 і загального запуску.
  - SC-013: шкала оновлюється за ≤2 с.
  - SC-014: видалення — 1 с, 1 хв, 15 хв.
  - SC-005 — навантаження M3.
- **Обмеження.**
  - Слабка машина: один важкий процес, жодного повного suite локально.
  - Міграції лише адитивні.
  - Огорожа прибирання для нових таблиць, що потрапляють в інвентар ([data-model.md](data-model.md)).
  - Бета-міграції — через `psql`.
  - Жодного нового опитування в браузері.
  - Агент споживає CPU лише через наявний PowerGovernor.
  - Похідні не залежать від агента.
  - Бюджет пілоту — нуль, отже без постійно ввімкнених серверів.
- **Масштаб.**
  - Пілот — 1 власник і кілька тестувальників.
  - Загальний запуск — ~24 простори своєї команди (`memory`: 24 акаунти). Ліміт 100 000
    матеріалів на простір.
- **NEEDS CLARIFICATION** розв'язано в [research.md](research.md). Відкриті кваліфікації
  (Containers, контрольні суми частин, юрисдикція) — це задача T001, яка блокує M1, а не дизайн.

## Перевірка конституції

Перед дизайном і після нього — PASS, за умови доказів під час імплементації.

| Принцип                | Як дотримано                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I — типізовані межі    | Контракт у `packages/shared/src/team/space-storage.ts`: дискриміновані стани завантаження, похідних і категорій. Байти — десятковий рядок. Ліміти — константи. Відповіді R2 і Worker розбираються як `unknown`                                             |
| II — релізний контракт | `AGENT_TOOL_CONTRACTS.teamWorkspace` 2 → 3 і `WEB_TOOL_REQUIREMENTS` лише в `packages/shared/src/release.ts`. Зміни агента й shared → повний реліз через раннер (beta → next → promote). Швидкий веб-шлях для M1 не підходить                              |
| III — найменші права   | RLS на всіх нових таблицях. Ключі R2 лише на сервері. Грант читання — короткий HMAC, без сирих presigned GET. Окремі облікові дані для B2 (M3). У журналі немає імен, шляхів і ключів                                                                      |
| IV — процеси й ресурси | ffmpeg і libvips — у Container з межами CPU, пам'яті й часу. В агенті — наявний керований seam і PowerGovernor; «Вхідні» вантажать ≤4 частини паралельно                                                                                                   |
| V — HTTP               | Наявний конверт `{ error: CODE }`, коди 202/403/409/413/503 за [contracts/storage-api.md](contracts/storage-api.md)                                                                                                                                        |
| VI — веб, стан, дизайн | Шкала пам'яті — компонент інвентаря `apps/web/src/components/ui/StorageMeter.tsx`, кольори — нові токени в `tokens.css` (світла й темна тема). Один Realtime-канал простору, локальний агентський SSE без змін. Нового опитування немає. Тексти через i18n |
| Аналітика              | Серверний журнал `private.space_storage_journal` + проєкція і CLI `space-storage` (M1). Коди зареєстровані в `code-map.ts` і `coverage-registry.ts`. Розширення `investigate`/`inspect`/`audit` — M3                                                       |

Поправок до конституції не потрібно. Новий застосунок `apps/space-derivatives/` виправданий
FR-038: ні Deno edge, ні Worker не запускають ffmpeg, а агент для похідних заборонений.

## Структура

### Документи (`specs/057-r2-workspaces/`)

- `spec.md` — джерело істини.
- `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `tasks.md` — цей набір.
- `contracts/storage-api.md` — новий обсяг.
- `contracts/legacy-policy.md` — правило архіву, верхній розділ.
- `contracts/migration.md` — «переносу немає».
- `contracts/recovery.md`, `contracts/diagnostics.md` — вирівняні під новий обсяг.
- `drive-losses.md`, `architecture-inventory.md`, `backend-evidence.md`, `provider-research.md`
  — довідка.
- `pricing.md` — відкладено.
- `evidence/`, `reviews/`.

### Код

Нове:

```text
packages/shared/src/team/space-storage.ts          # контракт, стани, коди, ліміти
supabase/functions/space-storage/                  # edge-функція: create, uploads, mutate, read-grant, agent, share-links
supabase/functions/space-storage-sweeper/          # видалення, сироти, звірка (pg_cron)
supabase/functions/_shared/r2-space.ts             # клієнт bucket простору поверх aws4fetch
apps/catalog-image-delivery/src/space-read.ts      # Worker читання з грантом і Range
apps/space-derivatives/                            # Queue-споживач + Container (ffmpeg, libvips)
apps/web/src/team/storage/                         # spaceUpload.ts, spaceCache.ts, CreateR2Space*.tsx, StorageMeterPanel.tsx
apps/web/src/components/ui/StorageMeter.tsx        # компонент інвентаря
apps/web/src/pages/admin/StorageR2PilotsCard.tsx
apps/agent/src/team-bridge/r2-transfer.ts          # multipart у R2, Range з files-хоста
apps/agent/src/team-bridge/inbox.ts                # «Вхідні» (M2)
scripts/analytics/space-storage.ts
supabase/migrations/<ts>_space_storage_*.sql
supabase/tests/database/space-storage-*.test.sql
tests/space-storage-*.test.ts
```

Розширюється наявне (підтверджено читанням коду, див. [research.md](research.md)):

```text
apps/web/src/api/team.ts                     # list_my_teams_v2, R2-гілки upload/download/preview/mutate
apps/web/src/team/create/CreateSpaceWizard.tsx, lobby/SpaceCard.tsx (spaceReadiness)
apps/web/src/team/useTeamRealtime.ts, TeamContext.tsx, useWakeCatalogSync.ts
apps/web/src/team/explorer/useExplorerUploads.ts, useSelectionDownload.ts, useThumbnailSession.ts
apps/web/src/team/preview/MaterialPreview.tsx
apps/web/src/team/tasks/TaskAttachmentTile.tsx, library/CopyDriveLinkButton.tsx
apps/web/src/team/product-catalog/ і catalog-updater/  # стрічка замість Sheet
apps/web/src/components/ui/index.ts, styles/tokens.css, pages/admin/, pages/AdminPage.tsx
apps/web/public/manifest.webmanifest           # share_target (M2)
apps/agent/src/team-bridge/transfer.ts, download.ts, process.ts
packages/shared/src/release.ts, src/team/transport.ts, src/types.ts
supabase/functions/drive-ops/{index,product-catalog,catalog-video-process-grants,process-output-upload}.ts
supabase/functions/catalog-updater/worker.ts, catalog-video-r2/worker.ts, catalog-sync/index.ts
supabase/functions/_shared/{product-catalog,catalog-updater}.ts
scripts/analytics/{cli,code-map,coverage-registry,investigate}.ts
```

**Рішення щодо структури.** Нова логіка сховища зібрана в одну edge-функцію `space-storage` і
один shared-модуль.

- **Файлові маршрути `drive-ops` і `drive-transfer`** не отримують R2-гілок. Завантаження,
  мутації, скачування й прев'ю R2-простору вони відхиляють з `STORAGE_BACKEND_MISMATCH`.
- **Каталожні маршрути `drive-ops`** (`/product-catalog/*`, `/catalog-publication/*`,
  `/catalogs/*`) — виняток. Каталог — це бізнес-логіка, а не сховище. Тому вони стають
  обізнаними про сховище через два шви:
  - запис документа (`CatalogDocumentWriter`: Google Sheet або CSV-стрічка);
  - джерело байтів (грант Drive або URL читання R2).

  Переписувати каталоги вдруге в `space-storage` не треба.

- **Спільне з Drive-шляхом:** `team_materials`, `private.can`, побудовники рядків каталогу,
  механізми 045/050.

## Етапи

### M1 — пілот власника на next

**Обсяг:** US11, ядро US1, ядро US7, US9, US10.

1. **Кваліфікація (T001).** Контрольні суми частин, CORS, юрисдикція, Containers. Результат —
   `evidence/qualification.md`. Без нього етап не починається.
2. **Схема.** Модель M1 з [data-model.md](data-model.md): пілоти, `storage_backend`, nullable
   Drive-поля, об'єкти, посилання, облік, резервування, завантаження, похідні, видалення,
   звірка, сигнали, журнал. Огорожа прибирання. `list_my_teams_v2` і фільтр у
   `list_my_teams`. R2-гілки в RPC списків.
3. **Сервер.**
   - `space-storage`: створення, завантаження, мутації, кошик, грант читання, агент.
   - `space-storage-sweeper`.
   - `drive-ops`, `drive-transfer` і `catalog-sync` відхиляють R2-простір.
4. **Доставка.** Worker `space-read`, Container похідних, Queue, правила життєвого циклу R2,
   правило кешу стрічок.
5. **Веб.**
   - Створення «На R2» лише на next і для пілоту.
   - Провідник через `space-storage`: multipart з паралельними частинами й продовженням,
     скачування будь-якого розміру, відео через Range.
   - Кеш IndexedDB і сигнали Realtime. Для R2-простору немає «синхронізувати».
   - Шкала пам'яті й список «Звільнити місце». Попередження 80/95/100%.
   - Вкладення завдань. Посилання Drive приховане (замінник — M2).
6. **Каталоги.** Стрічка CSV у R2, джерела з R2, байти 045/050 в обліку, миттєве видалення.
7. **Агент контракту 3.** Читає джерела з R2, пише результати multipart у R2. Прод-агент
   контракту 2 отримує `AGENT_UPDATE_REQUIRED`.
8. **Адмінка.** Картка пілотів із лімітом обсягу.
9. **Діагностика.** Журнал, коди, CLI `space-storage`.
10. **Реліз на next.** Повний раннер (агент змінився). Promote не робиться.

**Вихід з M1:** власник проходить US7–US10 на next без розробника. Заміри SC-013 і SC-014 —
на фікстурі. Перевірка ізоляції SC-016 пройдена: прод-веб, прод-агент, Drive-простори.

### M2 — входи й доказ швидкості

**Обсяг:** US8, решта US7, FR-035, FR-042–FR-044, FR-051, SC-011, SC-012, SC-015.

- «Вхідні» в агенті: папка на простір, хеш, `idempotency_key`, продовження після сну, стан у
  провіднику, налаштування «видаляти після вивантаження» (вимкнено типово).
- Мобільний провідник і `share_target` у `manifest.webmanifest`. Обмеження iOS і Android
  показані словами.
- Посилання Soty на перегляд і скачування (FR-043).
- «Скачати папку» через агента (FR-051).
- Пояснення втрат у місці, де людина шукає можливість (FR-044, рядки
  [drive-losses.md](drive-losses.md)).
- Заміри SC-011 на парі Goor ↔ пілотний простір → `evidence/speed-sc011-<дата>.md`.
  Якщо операція повільніша — фікс і повтор, поки ціль не досягнута.

**Вихід з M2:** SC-011 пройдено. Кожен рядок drive-losses має тест або видиму втрату
(SC-012). SC-015 пройдено.

### M3 — умови загального запуску

**Обсяг:** US2, US3, US5, US6, FR-001 (для всіх), FR-004, FR-006, FR-021 (частково),
FR-023–FR-030, FR-034, FR-055–FR-058.

- **Політика запуску.**
  - `storage_launch_policy` і `admin_activate_storage_launch()` у ранбуці promote.
  - `create_team` після T0 створює лише R2. `ConnectStorageFlow` недоступний для нових
    просторів (FR-001, FR-056).
- **Архів.** `private.space_is_archived` у `private.can`, пропуск у `catalog-sync`,
  `catalog-updater` і фонових роботах. Банер із датою D, нагадування 30/14/7/1 через
  наявний механізм листів 034 (`tariff-notices`), картка каталогу «Soty більше не оновлює»
  (FR-057, FR-058, SC-017).
- **Місткість у 034.** `space_tariffs.storage_bytes` (типово 15 ГБ) і `extra_storage_bytes`
  (+10 ГБ кроком). Адмін-діалоги видачі й зміни, шкала й тариф простору.
- **Після тарифу** (FR-021, частково). Коли 3 дні грації минули, R2-простір стає лише для
  читання й експорту, дані зберігаються. Автоматичного видалення через 90 діб у першому
  релізі немає — лише явна дія адміністратора. Див. «Відкладене».
- **Резерв** (US5): реплікація в B2 з Object Lock, знімок метаданих, restore drill, аварійна
  адреса лише для читання ([contracts/recovery.md](contracts/recovery.md)).
- **Діагностика** (US6): `investigate`, `inspect`, `audit`, `storage-capacity`.
- **Паритет і навантаження.** Матриця паритету ([architecture-inventory.md](architecture-inventory.md))
  на трьох платформах агента (SC-006), навантаження SC-005 на беті, звіт витрат для власника
  (FR-029, FR-034).
- **Реліз.** Повний раннер: beta → next → promote. Запис T0.

**Вихід з M3:** усі гейти вище зелені, власник бачить звіт витрат і результати навчання,
promote — на слово власника.

## Відкладене (свідомо, не забуте)

| Що                                                              | Чому                                                                                | Де лишається                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------- |
| FR-015, FR-018 — організація, спільна місткість, унікальні люди | рішення 2026-11-27: перший реліз бере 034 на простір                                | spec.md, [pricing.md](pricing.md) |
| FR-019 — ціни Solo $5 і доповнення                              | те саме; ціни на поверхнях користувача заборонені 034 FR-011                        | pricing.md                        |
| FR-022 — зниження пакета                                        | немає пакетів                                                                       | spec.md                           |
| FR-020 — quote/credit                                           | конвертації немає (FR-055), quote — разом із пакетами                               | spec.md                           |
| US4.2, US4.4, US4.5                                             | залежать від FR-015/018/019/022                                                     | spec.md                           |
| SC-008 — маржа тарифної сітки                                   | немає сітки. Замість неї M3 дає звіт фактичних витрат R2 (FR-029, FR-034)           | pricing.md                        |
| FR-021 — автоматичне видалення через 90 діб і листи перед ним   | перший реліз лише блокує запис і зберігає дані. Видалення — явна дія адміністратора | spec.md                           |

**Як читати «пакет» у специфікації.** У US1.1 («оплачений пакет із вільним слотом»), US1.3
(«переповнений пакет») і FR-016/FR-017 «пакет» у першому релізі означає видачу 034 на один
простір із місткістю (M3), а в пілоті — дозвіл `storage_r2_pilots` з лімітом обсягу (M1).
Слот простору — сама видача 034. Окремого лічильника просторів немає.

## Втратило силу (FR-055)

FR-002, FR-003, FR-005, FR-007–FR-010; SC-002; SC-003 (замінено SC-017). Частини FR-016,
FR-017, FR-030 і US5.3 про міграцію. Контракт [contracts/migration.md](contracts/migration.md).
Таблиця 2026-11-14 у [contracts/legacy-policy.md](contracts/legacy-policy.md). Задач на них немає.

## Відповідність вимог етапам

| Етап | Вимоги                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1   | FR-011 (провідник, вкладення, каталоги, результати обробки), FR-012–FR-014, FR-016, FR-017, FR-031, FR-032, FR-033, FR-036–FR-041, FR-045–FR-050, FR-052–FR-054; SC-001 (для пілоту), SC-013, SC-014, SC-016 |
| M2   | FR-035, FR-042–FR-044, FR-051; SC-011, SC-012, SC-015                                                                                                                                                        |
| M3   | FR-001, FR-004, FR-006, FR-011 (повний паритет), FR-021 (частково), FR-023–FR-030, FR-034, FR-055–FR-058; SC-004, SC-005, SC-006, SC-007, SC-009, SC-010, SC-017                                             |

## Ризики

- **Containers недоступні або дорогі.** Запасний шлях (R5): мала VPS з тим самим образом.
  Вирішує T001 до початку M1.
- **R2-рядки в `team_materials` ламають наявні запити.** Запити, що з'єднують
  `team_drive_connections` чи читають `drive_file_id`, для R2-рядка дають null. Захист:
  - R2-простір не дістається старим клієнтам (R6);
  - SQL-тест з R2-рядком у кожній зачепленій функції (T007);
  - grep-інвентар таких функцій як частина T008.
- **Promote збірки з M1 до M3.** Нічого не вмикає для інших: створення R2 вимагає пілоту до T0.
- **Пілот на прод-даних.** Окремий bucket і окремий рядок у звіті витрат (FR-053). Видалення
  пілоту перевіряє нуль залишку (SC-016).

## Складність

Порушень конституції немає. Свідомі складності:

- новий застосунок `apps/space-derivatives/` (FR-038);
- облік із лічильником посилань (FR-045, FR-048);
- межа пілоту з трьох умов (FR-052, FR-053).

Старий дизайн із канонічними таблицями-двійниками, епохами авторитету й міграцією знято разом
із переносом.
