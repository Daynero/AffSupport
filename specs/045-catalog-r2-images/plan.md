# Implementation Plan: R2-зображення каталогів

**Branch**: поточна робоча гілка `beta`; логічний feature ID `045-catalog-r2-images`, окрему git-гілку не створено | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)

**Input**: Спека 045 з уточненням про звичайні картинки у випадковому режимі. Це дизайн і таски, не реалізація/production-активація. Чужі поточні зміни робочого дерева не включати до майбутнього feature commit.

## Summary

У налаштуваннях каталогу з'являється імпорт папки Drive або локальних файлів. Одна дія «Проаналізувати й завантажити» формує готовий R2-пул. Класифіковані картинки мають пару одяг+колір; звичайні теж готові та випадково вибираються без семантичного зіставлення. Soty зберігає компактний словник metadata/URL, оригінали повторно не читаються для кожного каталогу.

Новий серверний контур `catalog-images` керує імпортом, приватним staging, перевіркою, незмінною публікацією й очищенням. Не розширювати Drive-upload enum новими несумісними значеннями. Публічне читання — власний домен R2 без Worker на кожний GET. Надійність забезпечують DB-журнал, lease/fencing, conditional create, positive reconciliation і окремі докази publication/dictionary/catalog delivery.

## Technical Context

**Language/Version**: TypeScript strict у чинному npm monorepo; Deno Supabase Edge; PostgreSQL із чинними migration/pgTAP seams. Node runtime — чинний root engines `>=22.12 <25`.

**Primary Dependencies**: React, HeroUI v3/React Aria, наявний Supabase client; pinned Deno-compatible AWS S3 client/presigner через function-local import/lock. Конкретний exact dependency lock фіксується T003 до реалізації; не змінювати runtime агента для image-only функції.

**Storage**: два R2 Standard buckets — private staging і public immutable images; Supabase metadata/RLS/RPC/leases; наявний Drive як джерело, не додаткова ціль local drop.

**Testing**: single-worker Vitest, pgTAP через isolated DB runner, browser beta з реальними R2 sandbox buckets; `npm run verify`, перед release `npm run verify:release`, exact-SHA packaged beta.

**Target Platform**: web desktop/touch/keyboard, macOS/Windows packaged clients; серверний імпорт працює без запущеного агента. Жодного process.platform/process spawn.

**Project Type**: зміна web + shared domain types + Edge Functions + DB + analytics; повний release, не 043 web-only/DB-mini.

**Performance Goals**: 50×15 каталогів/день; пул 25 000 image objects у базовому кошторисі. Після readiness — 0 повторних upload незмінних байтів; для dictionary first page/status p95 ≤2 s на 25k записів, UI залишається інтерактивним при 1000 dropped files. Старі каталоги/оновлення не обмежуються штучними 7 днями.

**Constraints**: один файл на worker invocation і **одна byte-heavy операція на Edge isolate**, ≤50 000 000 bytes, ≤16 000 000 pixels; без decode/reencode. Isolate-local nonblocking semaphore отримується до DB claim/читання bytes; busy повертає bounded requeue, без lease/buffer/внутрішньої необмеженої черги. Global/team DB permits — окремі межі, не заміна isolate admission. 256 MB Edge memory / 2 s CPU — зовнішні жорсткі межі; beta acceptance ≤192 MB **aggregate isolate peak** при конкурентних 50MB requests і ≤1.5 s CPU на кожну найгіршу підтримувану invocation. Якщо межа не виконується, readiness blocked: не знижувати мовчки 50 MB і не називати benchmark пройденим.

**Scale/Scope**: одна import job — до 1000 файлів і 5 GB заявлених байтів; папка >ліміту повертає явний continuation, не «усі імпортовані». Manifest pages ≤100 записів /1 MB metadata; dictionary pages ≤100, keyset cursor, total і hasMore. Максимум 2 активні jobs/простір, 2 worker файли/простір і 8 глобально; браузер 2 PUT одночасно. Початкові publication quotas: 100 000 активних pool entries і 50 GB ready bytes/простір, перевищення явне; конфігурація змінюється тільки довіреним оператором. Ready retention не зникає при досягненні quota.

## Constitution Check

| Принцип | Рішення | Pre / post design |
| --- | --- | --- |
| I: typed boundary | Новий discriminated contract у shared; усі HTTP/RPC/provider values parse як unknown; закриті errors | PASS / PASS |
| II: release contract | Агентні tools/protocol не змінюються; shared build і canonical packaged beta/full release обов'язкові | PASS / PASS |
| III: least privilege | manage_metadata; Drive download/live ancestry; private staging; service-only transitions; RLS narrow grants; no secrets in web | PASS / PASS |
| IV: resources | Немає child processes; bounded bytes/CPU/concurrency/retries; abort/lease fencing | PASS / PASS |
| V: HTTP/errors | Чинні `{error}` conventions; незалежні import operations, не підроблені Drive uploads | PASS / PASS |
| VI: UI/state | Існуючі UI inventory/tokens; один team Realtime owner, authoritative reread; без recurring client polling | PASS / PASS |
| 031 diagnostics | Повний signal→projection→CLI, missing evidence і privacy acceptance, не лише emit | PASS / PASS |
| Media policy | Вузький owner-requested виняток для public catalog images; тексти privacy/terms/NO_SERVER_MEDIA_PLAN оновлюються до enable | PASS as planned gate / implementation evidence pending |

Немає виправданих порушень constitution. Plan readiness не означає, що product/beta gates вже пройдені.

## Project Structure

### Documentation (this feature)

`spec.md`, `research.md`, `image-guide.md`, `cost-model.py`, `cost-estimate.json`, `plan.md`, `data-model.md`, `contracts/catalog-images.md`, `quickstart.md`, `tasks.md`, `analysis.md`, `reviews/`.

### Source Code (repository root)

Нові шляхи нижче є запланованими, а не вже створеними файлами продукту.

- `packages/shared/src/team/catalog-images.ts`, exports; analytics closed types у `packages/shared/src/types.ts`.
- `supabase/functions/catalog-images/{index,handler,worker}.ts`; `_shared/{catalog-images,r2-catalog-images,catalog-image-validation}.ts`.
- `supabase/migrations/<next>_catalog_r2_images.sql`, `<next>_catalog_r2_diagnostics.sql`; `supabase/tests/database/catalog-r2-images.test.sql`.
- `apps/web/src/api/team-catalog-images.ts`, `apps/web/src/team/product-catalog/{CatalogImageImport,useCatalogImageImport,catalogImagePrompt}.ts[x]`; існуючі settings/apparelTexts.
- Create/refresh integrations: `supabase/functions/drive-ops/{index,product-catalog,catalog-durable,launch-catalog}.ts`, `catalog-updater/{index,worker}.ts`, `_shared/{product-catalog,catalog-image-sharing}.ts`; standalone producer `apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx` та API input.
- Gateway/worker deployment: `supabase/config.toml`, function-local dependencies; errors registry `packages/shared/src/team/transport.ts`, analytics failure codes у `packages/shared/src/types.ts`, `_shared/errors.ts`, `apps/web/src/team/errors.ts`.
- `apps/web/src/team/useTeamRealtime.ts`, `apps/web/src/lib/database.types.ts`, `apps/web/src/locales/{uk,en}.ts`.
- `scripts/analytics/{catalog-images,catalog-updates,investigate,queries,schema,coverage-registry,code-map,cli}.ts`.
- Cleanup: `supabase/functions/delete-account/handler.ts`, existing draft-team RPC, нові purge RPC/worker; `apps/web/src/pages/legal-content.ts`, `docs/{NO_SERVER_MEDIA_PLAN,PRODUCTION,BETA}.md`.

**Structure Decision**: чинний monorepo і hosted team seams; новий домен імпорту ізольований від native media processing. Без нового Cloudflare Worker, системи local caches або клієнтського scheduler.

## Phase 0 — Research decisions

[research.md](./research.md) зберігає тарифне дослідження та рішення D1–D12 нижче. Офіційні обмеження R2/Edge перевірено; усі design unknowns мають рішення. Реальні credentials/domain/beta fixtures — deployment prerequisites, не вигадана наявна інфраструктура.

1. **D1 — publication boundary**: браузер отримує staging-only presigned PUT на 5 хвилин. Final key тільки server-writable. Верифікатор публікує той самий перевірений буфер, а не повторно копіює mutable staging. URL може повторно використовуватися до expiry: replay не змінить final bytes.
2. **D2 — runtime**: окрема Supabase function із DB cron dispatch; `requireNamedWorkerSecret`, lease RPC та один файл на invocation/isolate. `[functions.catalog-images] verify_jwt=false` у `supabase/config.toml`: gateway пропускає до handler, але user routes окремо виконують `authorizeCaller`, worker route — тільки named secret, ніколи fallback між ними. OPTIONS лише CORS, не робота. Local не потребує Drive OAuth. Browser close не зупиняє підготовку вже доставлених staging bytes або Drive job.
3. **D3 — validation**: actual size, SHA-256, JPEG/PNG/WebP structure, frame dimensions, static/animation flags, orientation. Без повного decompress/decode та візуального AI. Невідома/непідтримувана orientation повертає `IMAGE_ORIENTATION_UNSUPPORTED`, а не reencode. Public GET підтверджує hash/size/type; visual/consumer acceptance — окремий доказ.
4. **D4 — quota**: publication bytes/entries і in-flight reservations атомарні. Staging presign сам не доводить 50 MB ingress limit: 8 outstanding grants/простір, 10 grants/minute/actor, staging age cleanup після expiry; фактичні oversized bytes ізолюються, видаляються і зупиняють видачу нових grants для offending job. Залишкова exposure приватного ingress явно вимірюється, а не видається за hard byte cap.
5. **D5 — identity**: server SHA-256+size scoped by team, незалежний random opaque publication key. Source material optional; pool membership не є retention ownership. Cross-team dedup відсутній. Конфлікт класифікації однакових bytes не переписує чинний mapping.
6. **D6 — selection**: один no-repeat draw для всіх active ready members, під per-team advisory lock. matched-файл узгоджує type/color; unclassified отримує generic random clothing text без semantic guarantee. У змішаному пулі немає автоматичного виключення generic entries. Selection заморожується на attempt, retry не робить новий draw.
7. **D7 — pairing**: єдиний server pairing helper для create/refresh/grow. За `refreshTexts=false` та `refreshImages=true` зміна matched image може виправити лише type/color та пов'язані category/tags у копії рядка; ціна та інші довільні поля не регенеруються. UI пояснює, що відповідність фото потребує такого виправлення. Якщо title не має однозначного garment, у полях конфліктні type/color або результат виходить за 200/9999 characters, `IMAGE_TEXT_PAIRING_CONFLICT` до зовнішнього запису зберігає попередній каталог; recovery — увімкнути оновлення текстів/виправити слова і повторити. Нові rows/text-refresh можуть отримати canonical factual fallback. Повна матриця прапорців і token-only policy у contract. Unclassified не примушує вигадані facts. Legacy/fallback залишається чинною явно окремою гілкою.
8. **D8 — compatibility**: v2 draw/checkpoint discriminants `legacy_drive|r2`; нові RPC не змінюють v1 result shapes. Старі checkpoints читаються як legacy і добігають старим шляхом. R2-only imports/selection доступні лише v2 writers після backend-first enable. Legacy settings mutation блокується явним upgrade-required, коли team перейшов на v2; старі issued URLs не відкликаються.
9. **D9 — delivery**: origin-readback, public-readback, dictionary commit, catalog readback і зовнішній importer — різні outcomes. Cache negative TTL=0 для missing objects; explicit revocation purges власний CDN. External copies залишаються unobservable.
10. **D10 — retention**: active ready copies retained indefinitely, доки нема explicit revocation/team deletion. Звичайне source/uploader deletion не видаляє shared bytes. Окрема purge tombstone без cascading team FK переживає видалення. Temporary cleanup лише після grant expiry+lease grace та proof no use.
11. **D11 — UX**: two sources, one CTA; normal unclassified count, назви як matching opt-in без додаткового toggle. Підказка і copy-prompt із guide; keyboard/touch fallback. Local source bytes не persist; після reload потрібне reselection недоставлених файлів.
12. **D12 — release**: additive schemas/functions disabled → compatible web/shared → isolated beta → explicit production activation. Вимкнення new writes зберігає R2 reads та завершені використання. Жодної автоматичної rewrites/deletions production під час підготовки.

## Phase 1 — Design

### Import flow

1. UI отримує доступні capabilities, права й status; локальний шлях не запитує Drive credentials. Вибір/drop створює лише локальну чергу.
2. CTA start із idempotencyKey та source kind створює DB job. Для local manifest pages йдуть до явного seal; для Drive сервер перелічує descendants із dedup, page cursor і frozen source versions. Неповна/обрізана enumeration не є sealed complete snapshot.
3. Local видає staging grants тільки для admitted entries; digest клієнта — hint, не authority. Після PUT браузер підтверджує delivery; lost reply звіряється через entry status. Worker може знайти delivered object через bounded reconciliation після client disconnect.
4. Worker claim+fence; повторна authorization; bounded source read; структура/hash; scoped dedup; reserve publication candidate до будь-якого public PUT. Grant/lease state не авторизує final commit після cancel/revoke.
5. Public PUT create-once; origin та public byte readback; DB transaction commit publication+membership+entry terminal+safe journal. Якщо DB commit не пройшов, public candidate не стає ready й має durable owner для reconciliation/cleanup.
6. Unknown PUT не трактувати як failure за negative HEAD: conditionally повторювати тільки same-key/same-bytes з чинною fence, adopt лише позитивно підтверджений вміст. Hash mismatch — conflict, не overwrite.
7. Job completed/partial/failed/cancelled виводиться з entries. Unclassified ready — success. Cancel знімає pending work, але вже ready результати не видаляє. Файли, які не пройшли commit після revoke, отримують cleanup tombstone; коротке вікно між revoke й зовнішнім PUT не видається за атомарний cross-provider revoke.
8. Після reload hook знаходить jobs через paginated `GET /imports?teamId=…`, а не лише з пам'яті вкладки. Collecting manifests та waiting-source local entries без дієвої user activity протягом 24h переходять в expired/partial; worker heartbeat/read не продовжують source deadline. Delivered/staged/ready і write-unknown не видаються за відсутні bytes; job зі staged entries завершує їх, а undispatched waiting entries expire. Exactly-once reservations release, ready результати збережені. Unknown external writes переходять у окремий reconciliation state, не займають два active-upload slots назавжди; storage exposure лишається в окремому обліку до звірки.

### Recovery, cleanup та ресурсні межі

- Worker lease 90 s, heartbeat 20 s, maximum request wall budget 60 s; fencing counter на кожний claim. Renew/deadline ownership перевіряється перед I/O та commit. Timeout aborts активні fetches, releasing resources; no unbounded background promise.
- 3 automatic attempts/file **включно з першою**: одразу, повтор через 1 min, останній через 5 min після другого failure. Read-only reconciliation unknown outcome — до 8 перевірок через 15 min, далі explicit unknown/manual reconciliation; це не додаткові сліпі PUT і не нова final identity. Після ліміту явне user retry/new attempt із тим самим intent/source version; uncertain write спершу звіряється.
- Staging grant 5 min; cleanup не раніше expiry+5 min і без live lease. Після цього повторне очищення з readback; write-in-flight/unknown не стає доказом absence. R2 staging lifecycle 1 day — страховка, не підстава видалити public copies. Temporary candidates ≤24 h від last active attempt, unknown/live use defer+finding.
- Default quota reservations release exactly once on terminal; reused objects не рахуються двічі. Retained public objects продовжують рахуватися у storage estimate навіть після pool removal. Staging byte overages і orphan candidates окремі від ready budget.
- PUBLIC bucket не приймає browser writes; no list route; ключі випадкові без source names/content hashes. Public `Content-Type` перевірений, `Content-Disposition:inline`; `X-Content-Type-Options:nosniff` встановлює **Cloudflare response-header transform rule на media domain**, не S3 user metadata. Дозволені тільки image MIME. Окремі environment-scoped least-privilege permissions для CDN purge/zone transform; anonymous GET перевіряє реальні headers. CORS staging лише точні production/beta origins, методи PUT та потрібні headers, не wildcard credentials.
- Orphan cleanup та commit/adopt/reuse/use-reservation блокують **ту саму publication row**. Cleanup атомарно перевіряє no lease/use/membership/pending commit/write-unknown і CAS переводить candidate у `purging`, підвищивши publication fence. Усі adopters/committers відхиляють purging/fence mismatch. Переміг adoption — cleanup не має права видаляти; переміг cleanup — adoption не може зробити URL ready. External deletion починається тільки після цієї transaction; unknown/in-flight write не є eligible orphan. Explicit revoke/team delete — окрема destructive authorization із тим самим fencing та durable late-write reconciliation.

### Catalog integration

- Новий compact dictionary API повертає paginated metadata і aggregate actual-pair inventory без обрізання до legacy pool-name limit. Генератор текстів працює по існуючих matched pairs; random-only використовує загальний нинішній apparel generator.
- Незмінний publication ID/metadata заморожується в durable selection. Create/refresh/grow/Launch reuse читають v2 projection; R2 не проходить через ensureAnyoneReader. Legacy Drive і fallback external URL не маскуються як R2.
- Snapshot рядка зберігає publication ID та classification facts поряд із URL; історичні issued-use receipts не каскадують із source material. Новий каталог не припускає, що публічний GET доводить Meta ingestion.
- Нові drafts v2 і старі in-flight legacy можуть співіснувати. Runtime capability/contract rejection — до draw/Drive mutation; жодного silent fallback для непідтвердженої v2 image publication.
- Fresh standalone UI/API і серверний `drive-ops/launch-catalog.ts` передають version=2 після server team-mode admission. Launch retry використовує persisted version/checkpoint, не поточний feature flag для переосмислення прийнятої операції; legacy in-flight іде старим читачем. Перший v2 enable team — окрема CAS зміна після ready pool та server capability readiness; не відбувається неявно від GET чи drop.

### Diagnostics and privacy

[contracts/catalog-images.md](./contracts/catalog-images.md) визначає safe codes/events. Нові аналізовані шляхи: source/input → classification → bytes → publication → dictionary → catalog → terminal/recovery. Операційний журнал DB — authoritative fallback для відсутніх event terminals; CLI зберігає SELECT-only роль, guard і bounded views.

`investigate`, `inspect`, `audit`, `catalog` отримують import/publication links через opaque IDs; окремий `catalog-images <team-or-import-id> --period ... --as-of ... --json` показує paginated entries/aggregates. Schema support/freshness/lag/unknown origin metrics явні. Critical terminals не sampled; progress агрегований; no names/URLs/hashes/clipboard/provider payloads у telemetry. 30 days sanitized detail, 90 days aggregates за 031; operational retention для issued-use proof окремий від telemetry expiry.

### Delivery order and validation

Див. [tasks.md](./tasks.md): foundation → US1 import + US5 help → US2 integration → US3 migration/retention → US4 diagnostics → acceptance/full release readiness. US5 можна робити паралельно після vocabulary foundation; production MVP включає всі P1 stories, а не лише upload без diagnosis.

[quickstart.md](./quickstart.md) визначає runnable checks і synthetic acceptance matrix. Real sandbox measurements, importer acceptance та privacy corrections — release blockers. Відсутність credentials не перетворюється на simulated success; документація/таски можуть бути готові, product status лишається unverified.

## Complexity Tracking

Не додається порушення constitution. Два buckets потрібні через reusable untrusted PUT; одна public bucket із прямим browser grant не забезпечує незмінності перевірених байтів. Окремі import tables потрібні для сумісності Drive-only operation parsers, retention і командної власності.
