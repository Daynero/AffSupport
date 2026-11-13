# Research: загальний пул, перехід і швидка видача

**Дата**: 2026-11-12. Рішення проєктування; runtime/provider evidence ще не отримано.

## D01 — Один загальний пул від T0

**Decision**: прибрати всі користувацькі white-image налаштування й примусово застосовувати global policy у Create, Launch, manual/scheduled/retry/growth updater. Старе refreshImages=false не керує поведінкою. Сумісний UI і серверний fence активуються одним policy epoch.
**Rationale**: це остання пряма вказівка власника. Власний пул не є опцією навіть у перші 30 днів.
**Alternatives**: opt-in, перехід лише нових просторів та збереження перемикача відхилені. Retention старих байтів не означає збереження їхніх налаштувань.

## D02 — 200 issued slots і 5000 confirmed uses

**Decision**: на unique(catalog_identity,image_id) стійко видається один монотонний слот. generation = floor((issued_slot-1)/200)+1. Failure/cancel/unknown не повертає слот; retry тієї самої пари повертає попередній URL. Confirmed total зростає окремо після доказу фактичного збереження каталогу.
**Rationale**: чекати 200 committed каталогів і водночас не чекати чужих unknown неможливо. «200 підтверджень» було нашим попереднім припущенням, а не прямою вказівкою власника. Нова вимога швидкості визначає цей вибір. Один URL має ≤200 issued пар; committed може бути менше.
**Alternatives**: повторне використання failure-слотів і блокування наступної серії до звірки відхилені. Новий URL на кожен каталог також замінений правилом 200.

## D03 — Пакетний короткий allocator

**Decision**: один RPC allocate/freeze для всього набору до 400 рядків. Для 100/200 — жодного per-row RPC/GET. Випадковий обмежений набір ready кандидатів; короткі впорядковані per-image locks із SKIP LOCKED; зайняті/без готового alias кандидати пропускаються до freeze. Немає одного глобального advisory lock або циклу очікування. Усі зміни recipe/assignment/issued_seq — одна транзакція; невдалий повний набір відкочується.
**Rationale**: чинний drawCatalogImagePool уже має один RPC для всього count; service_draw_product_catalog_images_v2 у migration 20261207121000_catalog_creation_performance.sql читає словник один раз. Не переносити team lock у спільне глобальне вузьке місце.
**Alternatives**: ORDER BY random() над необмеженою таблицею, мережевий виклик на рядок, довгі locks під provider I/O й inline retries відхилені. PostgreSQL документує SKIP LOCKED як придатний для queue-like contention, а не загальний консистентний snapshot. [PostgreSQL SELECT](https://www.postgresql.org/docs/17/sql-select.html).

## D04 - Ready ahead with reusable identity proof

**Decision**: current+2 next aliases are prepared before use. Initial anonymous byte/MIME/nosniff proof establishes immutable alias identity. Fresh asset content proof24h plus serving-health120s and compatible route/protocol/key versions govern new allocation, including reuse of an old closed-generation alias. Health probes run at least every60s using the existing cron seam (045 already supports30-second schedules). Route/key changes require compatibility probes including old issued tokens.
**Rationale**: no GET/sign/upload/preparation in create/update and no daily re-fetch of every historical alias. Old-pair reuse after24h/rotation stays valid via inherited evidence. These are acceptance budgets, not global availability guarantees.
**Alternatives**: per-row public GET, expiring old alias identities, or waiting for repair in create are rejected. Missing/stale content/health proof skips candidate or yields fast unavailability.

## D05 — Прямий alias без DB lookup на кожен GET

**Decision**: окремий read-only Cloudflare Worker на шляху /g/ медіадомену. Він перевіряє непрострочуваний HMAC-SHA256 token із environment/key-version/global asset ID/generation/MIME, обмежує методи GET/HEAD, формує тільки довірений canonical /g1/asset-id object URL і stream-return його відповіді. Canonical path обходить /g/ route, тому немає рекурсії. Немає tenant/catalog ID, довільного upstream, JWT або service key у URL. Секрет лише в Edge/Worker runtime, не в браузері/артефактах. Старі verify keys не вилучаються, поки є видані URLs; ротація ключів без збереження читання заборонена.
**Rationale**: прямі різні адреси без копіювання байтів, редиректу й мережевого звернення до БД на кожну картинку. Worker робить canonical fetch з однаковим URL для всіх aliases; звичайний cache key тоді спільний, Enterprise cacheKey не є залежністю. Сам fetch/cache треба підтвердити на фактичному custom-domain route.
**Alternatives**: KV mapping із затримкою видимості, DB на кожен GET, фізичні копії на каталог і redirect відхилені. Query-only URL технічно можливий, але не обраний. [Cloudflare cache using fetch](https://developers.cloudflare.com/workers/examples/cache-using-fetch/), [Web Crypto/HMAC](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).

## D06 — Окремі глобальні сутності

**Decision**: global assets/aliases/catalog identities/assignments/confirmation receipts/aggregates — окремі private таблиці, не team-owned publications. Catalog identity існує до allocation й зберігається в Launch child intent та material registration. Unique pair не залежить від attempt/row/updater round. Видалення team знеособлює зв’язки, не скидає aggregate й не дозволяє double count.
**Rationale**: чинна private.catalog_image_uses має PK attempt+row_identity+publication та cascading team FK. Її рядки не є потрібним лічильником унікальних каталогів. Global objects мають власний namespace g1/, retired managed objects залишаються v1/.
**Alternatives**: перепризначити team publications глобальному власнику або рахувати telemetry events відхилено.

## D07 — Очищення через durable purge, не ad-hoc DELETE

**Decision**: T0+30 days фіксується один раз. Manifest містить лише доведено Soty-owned legacy image publications. Новий reason policy_retirement у чинному purge seam; він після дедлайну допускає retired ready publications попри історичні references. Tombstone живе поза cascading team FK. До дедлайну hold має пріоритет над team-delete/orphan/старим revoke. Quota credit лише після verified delete один раз.
**Rationale**: runCatalogImageWorker уже claim-ить purge перед перевіркою import enable; adapter remove робить DELETE, origin readback і CDN purge. Orphan eligibility навмисно не чистить ready/use references, тому masquerade під orphan некоректний.
**Alternatives**: окремий cron із прямим DELETE, передчасний credit, скидання unknown або подовження retention через paused catalogs відхилені. Original Drive/local і зовнішні permissions не є targets. Обіцянка cleanup поширюється лише на керовані origin/CDN, не external caches.

## D08 — T0, in-flight і rollback

**Decision**: стан prepared → draining → active → cleanup_due → cleanup_running → cleanup_complete/partial. Перед T0 зупинити нову legacy admission і завершити/звірити вже відправлені старі writes та grants; якщо є unknown, активація не дозволена. Готовий cutover manifest/compatible release/proof epoch фіксуються до одного атомарного T0. Після T0 server fence переживає code rollback, повторний deploy не змінює timer. Старі snapshots до side effects або мігрують у новий global recipe, або дають upgrade/replan required; не переплановувати невідомий provider write.
**Rationale**: зовнішній provider write не атомарний із БД. Сам epoch не зупинить вже відправлений запит. Підготовча активація може вимагати drain; звичайна post-T0 видача не чекає його.
**Alternatives**: безумовно завершувати legacy in-flight після T0 або скидати T0 при rollback відхилені.

## D09 — UI, old clients і pairing

**Decision**: прибрати image subtree у ProductCatalogSettingsSection і private readiness у CatalogSummarySection та launches/preparation.ts. Прибрати refreshImages controls/defaults/profile/bulk/undo, але не price/text controls. Старі mixed settings payloads із image fields відхиляються без часткових writes; новий contract3 їх не посилає. Усі backend producers застосовують global policy, а old clients отримують reload/upgrade до side effects. Shared schema/signatures additive для history; public UI не відновлює old controls.
**Rationale**: приховати лише gallery недостатньо — Launch і summary зараз залежать від приватного inventory. RestitchSourcePool/RestitchDefaultsSection використовують частину productCatalogImages translation keys, але їхні start/end screens не є білими зображеннями каталогу й мають залишитися.
**Alternatives**: CSS hide, silent ignore змішаного payload або лише заміна одного RPC не покривають усі шляхи. При refreshTexts=false підбирати сумісні фактичні пари; неможлива відповідність дає явний conflict без legacy fallback/вигаданого опису.

## D10 — Реліз і незворотна межа cleanup

**Decision**: три additive migrations плюс runtime очищення data/objects. Старі таблиці/колонки/сигнатури не DROP-аються. Повний canonical release з packaged beta, next→promote та окремим source/environment-bound cutover evidence. Worker bytes/config/probes включаються до цього evidence; не публікувати вручну через wrangler. Next на production data не активує T0 сам фактами деплою; активація лише нормальним явно дозволеним production workflow після promotion readiness.
**Rationale**: scripts/check-migrations-additive.mjs працює після baseline; acceptedWorkspaceCutover зараз прив’язаний лише до workspace-1.3.0 та конкретного digest. Маркер soty:cleanup сам по собі не дозволяє новий schema DROP. Ця фіча не переписує стару ратифікацію.
**Alternatives**: mini web release для DB/functions/Worker, ручні artifacts, down migrations або відновлення legacy writes при rollback відхилені. Фізичне schema cleanup — окремий майбутній release.

## D11 — Діагностика та бюджети

**Decision**: розширити наявний read-only CLI командою global-images, а diagnose/inspect/audit — capability discriminators global import/allocation/update/cutover/retirement. Нові closed codes проходять shared registry, UI maps, locales і analytics code map. Статус відокремлює issued/confirmed/unknown, all-time/current/as-of, legacy retained/due/pending/deleted/unknown та untouched external originals.
**Rationale**: агент повинен пояснити результат без dashboard/ad-hoc SQL; emitted event не є доказом каталогу або видалення. Малі bounded sanitized журнали є authoritative supplements, а не контентом.
**Budgets**: один batch allocation до400 рядків, один completion batch; DB lock_timeout=50 ms, statement_timeout=750 ms, caller deadline1 s. Warm p95≤250 ms, e2e overhead p95≤1 s. Benchmark:2000 ready assets,100/200 rows,≥100 samples per size та окремі 1/10 concurrent cohorts, rotation/busy/cold/exhausted/unknown. Background: current+2 aliases, one byte-heavy item/invocation, глобальний ліміт8,≤60s invocation; cleanup одна publication/invocation із чинними8 attempts/15min backoff, escalation unknown після вичерпання. Це цілі, не виміри.

## Межі доказів

Прямі GET й контрольний імпорт Meta — різні докази. Офіційна Meta catalog reference при перевірці повертала429, image help — сторінку входу/обмеження. Немає первинного підтвердження, що масове використання URL саме спричиняє рекламні обмеження. Інші адреси не змінюють байти/домен і не гарантують рекламного результату. Control import може підтвердити лише конкретний набір у конкретний час.

Розробка, реальні provider/browser/Meta перевірки, T0 і cleanup ще не виконані. Дослідження read-only; рішення повторно перевіряються після контрактів і tasks.

## Review resolutions

- Candidate sample uses indexed required factual buckets; scan exhaustion/locks are unavailable, not proof of no matching image. Distinct preference applies to checked unlocked candidates. Recheck pair under image lock before incrementing issued_seq.
- T0 drain includes already claimed DELETE/purge I/O. Unknown physical deletion blocks manifest finalization/activation.
- Manifest includes object_purge and metadata_unlink; Drive-only spaces finalize metadata without deleting originals or waiting for R2 receipts. Complete requires all typed targets terminal, no unknown ownership.
- Quota credit uses stable ledger identity/current charged owner after transfer, original manifest attribution audit-only.
- Pagination uses read-only tuple fingerprint/TTL and one bounded restart, with explicit partial result under ongoing changes. No global revision-row write bottleneck.
- T0 needs prior rollback build with policy-aware UI barrier; absent baseline is a release prerequisite, not an assumption old bundles support it.

## Implementation baseline

Branch feature/052-shared-white-images, isolated worktree AffSupport-052; base a7e30bca. Original release/1.4.3 worktree is clean and unchanged. No merge/release/main work is part of this implementation. Node22.23.2/npm10.9.8, private fresh workspace dependencies; no shared node_modules symlink. Existing Docker/Git/Prettier/ESLint ignores verified. Migration head20261207400400; reserved052 migrations remain later in lexical order.
