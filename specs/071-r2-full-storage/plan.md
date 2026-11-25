# Implementation Plan: 071 Повний переїзд сховища на R2

**Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md) · **Data model**: [data-model.md](./data-model.md) · **Contracts**: [contracts/](./contracts/)

**Base**: `main` `2dd6dab`. Робота починається після релізу 1.6 від свіжого `main`. У `integration/1.6-polish`, `release/*`, `next`, `beta` нічого не потрапляє в межах цієї спеки.

## Summary

Додати R2 як бекенд бібліотеки простору за абстракцією `StorageAdapter`. Перевести завантаження, прев'ю, мініатюри, агента, рестітч, лендинги й каталоги (CSV-фід) на R2 для просторів з `storage_backend='r2'`. Дати адміністратору ідемпотентний перехід простору. Після переходу всіх просторів видалити Drive-код і legacy-бакети Supabase.

## Technical Context

- **Мови й рантайми:** TypeScript (web React + HeroUI v3, агент Node), Deno edge-функції Supabase, Postgres-міграції + pgTAP.
- **Сховище:** Cloudflare R2 Standard. Два нові бакети на середовище: медіабакет `soty-media-<env>` з власним доменом і CDN (відео, картинки, мініатюри, фіди) і приватний `soty-private-<env>` без домену. Бакети 045/050 лишаються для Drive-просторів до етапу F, нові R2-простори їх не використовують.
- **Повторне використання:** SigV4 і multipart з `_shared/r2-catalog-images.ts`, `_shared/r2-catalog-video.ts`; tombstones і робітник 050; `TARGET_CONFIRMATION`-гейт; генератор колонок каталогу `_shared/product-catalog.ts`; WebP-кодер `_shared/catalog-webp`.
- **Тестування:** vitest single-worker (`--pool=forks --poolOptions.forks.singleFork=true`), pgTAP у `supabase/tests/database/`, `npm run verify` як єдина перевірка.
- **Дизайн:** нові екрани (квота, банер переходу, фід каталогу) тільки з компонентів `apps/web/src/components/ui/` і токенів `tokens.css`.
- **Обмеження:** машина виконує одну важку річ за раз (`uptime` перед збіркою чи набором тестів).

## Constitution Check

| Принцип | Як дотримано |
| --- | --- |
| I. Типізовані контракти на межі | `UploadPurpose`, `AgentStorageInput`, відповіді `storage-ops` — у `packages/shared`, валідатори на edge |
| II. Одне джерело правди протоколу | версія протоколу агента піднімається в одному місці; реліз повний, не web-only |
| III. Безпека й найменші права | приватний бакет, окремі ключі на бакет, presigned з коротким TTL, права перевіряються до підпису, видалення тільки списком, bucket lock |
| IV. Дочірні процеси й ресурси | агент не запускає нових процесів; multipart з обмеженим паралелізмом (4 частини) |
| V. HTTP і помилки | той самий конверт помилок; нові коди в `team_error_codes` |
| VI. Фронтенд | стан завантажень у наявному сторі завантажень, без нових глобальних сторів |

Порушень немає.

## Етапи

Кожен етап зливається в `main` окремо і вимкнений гейтом (`private.storage_r2_config.enabled=false`), поки не пройде beta.

### Етап A. Фундамент (без видимих змін)

- `_shared/r2/` (signer, multipart, readback, purge) виноситься з 045/050 без зміни поведінки; тести 045/050 зелені.
- Runtime-конфіг `R2_MEDIA_*` і `R2_PRIVATE_*` з `TARGET_CONFIRMATION`; `private.storage_r2_config`.
- Міграції data-model: `teams.storage_backend`, `soty_r2` підключення, `team_storage_objects`, `team_storage_usage`, `team_storage_upload_sessions`, `private.storage_tombstones`, коди помилок.
- `StorageAdapter` + `DriveAdapter` (обгортка, поведінка Drive побайтово та сама) + перевірка `verify`: `GoogleDriveClient` імпортується тільки в `_shared/storage/drive-adapter.ts` і в коді, позначеному до етапу F (allowlist, що тільки скорочується).

### Етап B. Бібліотека на R2 (US1, US5, US7)

- `storage-ops`: завантаження, частини, фіналізація, похідні, `read-urls`, використання, робітник.
- Web: завантажувач multipart (продовження, паралелізм 4, SHA-256 у Web Worker), мініатюри на клієнті, плеєр з поновленням URL, провідник бере URL мініатюр пачкою.
- Операції матеріалів: `rename/move/trash/restore/folders` через RPC для R2; `copy` → `CopyObject`; `text-edit` → новий об'єкт.
- Кошик 30 днів → tombstones → видалення з запобіжником; bucket lock на beta.
- Квота: норма на учасника, резерви, UI «зайнято X з Y», попередження 80/95.
- `share_copy` → `team_share_links` і `/s/:token`.
- Аналітика AD-001…AD-003, AD-005, команда `analytics storage`.

### Етап C. Агент (US2)

- Типи `AgentStorageInput`, `UploadPurpose.process_output|overwrite`; підняти версію протоколу.
- Агент: вхід через URL з поновленням, вихід multipart з локальним журналом, постер як похідний об'єкт; рестітч-джерела й екрани, рендери лендингів через ті самі шляхи.
- Сервер: `AGENT_UPDATE_REQUIRED` для старих агентів на R2-просторах.
- Перевірка на macOS (arm64, Intel 049) і Windows.

### Етап D. Каталоги на R2 (US3)

- Перевірка на beta: Meta приймає заплановане джерело з URL у CSV (Assumption 6). Якщо ні, XML-серіалізатор.
- Рендер фіда з бази тим самим генератором; golden-тест SC-004.
- `catalog-updater` для R2-каталогів: запис фіда з `If-Match`, очищення CDN, `feed_revision`.
- Для R2-просторів фід посилається на постійні медіа-URL матеріалів; копія 050 і публікація 045 не виконуються; `team_storage_object_uses` тримає медіа живих фідів (FR-019a); правило кешу медіадомену ігнорує `?v=` (R16).
- Створення каталогу (діалог, меню, запуски 035) повертає URL фіда; перегляд і XLSX у застосунку.

### Етап E. Перехід і нові простори (US4, US6)

- `team_storage_cutover_runs`, кроки FR-024, адмінка: запланувати, запустити, стан.
- Банер для учасників з датою й переліком переваг.
- `archived_drive`: приховати з бібліотеки, показувати «файл на Google Drive» у завданнях, запусках, каталогах.
- Нові простори на R2; онбординг без кроку Drive.
- (P3) Імпорт з Google Picker → копія в R2 робітником.
- Оновлення політики приватності, умов і `docs/NO_SERVER_MEDIA_PLAN.md` (гейт FR-030); `policy_confirmed_at`.
- Перехід просторів закритої команди: пілот на одному просторі 7 днів (SC-002, SC-003), далі решта.

### Етап F. Прибрати Drive

- Видалити Drive-код (R13), Drive-маршрути агента, `drive-transfer`, `drive-connect`, `drive-oauth-callback`; прибрати `drive.file` з OAuth-клієнта Google.
- Міграція 030 release C (бакет `team-restitch-images`) і видалення `team-thumbnail-cache` списком.
- `verify`: allowlist `GoogleDriveClient` порожній, а скрипт забороняє `googleapis.com/drive` і `sheets.googleapis.com` (SC-007).

## Ризики

| Ризик | Ймовірність | Захист |
| --- | --- | --- |
| Код іде в Drive API з синтетичним `r2_…` id | середня | `StorageAdapter` + allowlist у `verify`; тест, що `GoogleDriveClient` отримує `r2_` id → падіння |
| Meta не приймає CSV з URL | низька | перевірка першим кроком етапу D; XML |
| Медіа-URL переслали назовні | низька | 128-бітні ключі, без лістингу; відкликання видаленням файлу; прийнято власником (R16) |
| Видалення ламає товари в Meta | середня | uses живих фідів блокують tombstone (FR-019a) |
| Bucket lock заважає чистити незавершені multipart | низька | перевірка на beta до прод-увімкнення; lock тільки на завершених об'єктах |
| Перехід зупиняється посередині | середня | ідемпотентні кроки, повтор з адмінки, стан у `steps` |
| Старий агент на R2-просторі | висока на старті | `AGENT_UPDATE_REQUIRED` + банер оновлення; перехід простору тільки коли всі агенти простору на новій версії (перевірка в кроці 1) |

## Project Structure

```
supabase/functions/_shared/r2/            # signer, multipart, readback, purge (з 045/050)
supabase/functions/_shared/storage/       # StorageAdapter, drive-adapter.ts, r2-adapter.ts
supabase/functions/storage-ops/           # маршрути contracts/storage-routes.md + worker
supabase/functions/catalog-updater/       # фід-писач для R2-каталогів
supabase/migrations/2027…_storage_r2_*.sql
supabase/tests/database/storage-r2*.test.sql
packages/shared/src/team/storage.ts       # типи, квота, коди
apps/web/src/team/storage/                # uploader, thumbnails, usage, cutover banner
apps/agent/src/team-bridge/storage.ts     # вхід/вихід R2
scripts/check-no-drive.mjs                # гейт verify (етап A allowlist, етап F порожній)
docs/STORAGE_R2.md                        # операційна документація
```
