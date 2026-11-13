# Implementation Plan: обов’язковий загальний пул білих зображень

**Branch**: `feature/052-shared-white-images`, ізольований worktree `/Users/daynero/RiderProjects/AffSupport-052`, base `a7e30bca`. Робоча `release/1.4.3` і main не змінюються;052 не входить до найближчого релізу. **Date**: 2026-11-12. **Spec**: [spec.md](./spec.md).

**Input**: [Вимоги052](./spec.md), останні вказівки власника про T0/30 днів/швидкість. Це план, не виконання задач або production activation.

## Summary

Один платформний пул замінює всі власні налаштування від T0. Нові й оновлені каталоги отримують випадковий готовий набір; legacy false flags не діють. Старі Soty-owned копії читаються30 днів, потім durable purge прибирає їх і віджилі image-прив’язки. Originals, video, previews і restitch screens поза очищенням.

Швидкий шлях: один allocate/freeze RPC, короткі per-image locks, готові current+2 URL-series, immutable recipe та batch confirmation у чинному завершенні операції. Серія має200 issued pair slots; confirmed total5000 — окремий інформаційний облік. Unknown чужого provider write не затримує наступні видачі. Delivery Worker stream-return одного canonical cached об’єкта за перевіреним opaque alias, без DB запиту на кожен GET.

## Technical Context

**Language/Version**: TypeScript5.9 strict/ESM; Node22.12–24 для tooling; чинний Supabase Deno2 Edge runtime; Cloudflare Workers Web APIs. PostgreSQL17+.

**Primary Dependencies**: наявні React19.2.7, HeroUI3.2.5, Vite8.1.6, Supabase JS2.110.7 і aws4fetch1.0.20 у Edge. Новий delivery workspace використовує наявний Vite build toolchain, Web Crypto/fetch/Streams без SDK для runtime. При реалізації T001 перевірити lockfile й точні compatible versions; не піднімати чужі залежності.

**Storage**: private PostgreSQL state з RLS/service-only mutation functions; global R2 canonical objects `g1/<uuid>`, старі managed `v1/<uuid>`; existing durable purge queue. No tenant originals in global pool.

**Testing**: central tests/*.test.ts(x), Vitest one worker, pgTAP в ізольованому DB gate, real concurrent PostgreSQL connections, authenticated hosted/installed browser fixtures, isolated R2/Worker/CDN probes, reproducible benchmark. Нові тести потрібні через data integrity/cleanup/concurrency та прямо передбачені специфікацією.

**Target Platform**: hosted web, installed web macOS ARM/x64 і Windows; runtime platform branches не додаються. Read-only CLI на supported Node. Existing exact-SHA packaged release contracts лишаються чинними.

**Project Type**: monorepo web+Edge+CLI, один новий read-only media Worker workspace.

**Performance Goals**: warm allocation100/200 rows p95≤250ms; e2e overhead p95≤1s; caller allocation deadline1s. No per-row network, bytes work, preparation waits або global draw lock. Native restitch/Drive/Meta тривалості вимірюються окремо.

**Constraints**: stable URL без expiry/redirect;200 durable issued slots per URL; pair uniqueness;5000 committed threshold без блокування; T0+30×24h один раз; no production work у цьому плануванні. Повністю недоступний пул дає fast refusal, не неправдиву обіцянку «все працює без очікування».

**Scale/Scope**:2000 active images;50 просторів×15 нових каталогів/день і чинні оновлення;100/200-row main cohorts, contract максимум400. Alias preparation current+2, bounded workers, status pages default50/max100.

## Constitution Check

| Принцип                  | До research | Після design | Як забезпечено                                                                                                                                           |
| ------------------------ | ----------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I Typed boundary         | PASS        | PASS         | shared contract3/guards, unknown input validation, stable state unions, tests                                                                            |
| II Release/protocol      | PASS        | PASS         | повний release; fresh packaged beta; Worker source/config/probes bound to evidence; no mini bypass/T0 on next deploy                                     |
| III Least privilege      | PASS        | PASS         | RLS+revoke-all, service-only mutation RPCs with empty search_path; actor ACL recheck; operator-only global writes; SELECT-only CLI; secrets runtime-only |
| IV Bounded orchestration | PASS        | PASS         | no local heavy child runtime; one heavy verification child nice15, one worker; bounded Edge jobs/cleanup; existing managed seam if child ever needed     |
| V HTTP/error             | PASS        | PASS         | existing envelopes, closed codes/maps/locales/code-map; missing data unknown                                                                             |
| VI Composition/state     | PASS        | PASS         | remove image controls without replacing UI; existing inventory/tokens; one Realtime owner; no recurring client polling                                   |
| 031 Diagnostic coverage  | PASS        | PASS         | producer→sanitize→receipt/projection→CLI; retired inventory; end-to-end missing/delayed evidence tests                                                   |

PASS означає узгоджений дизайн, а не пройдені runtime gates. Немає виправданих винятків або змін constitution. Перед implementation перевірити freshness head; після runtime змін потрібні verify/release gates.

## Project Structure

### Documentation (this feature)

```text
specs/052-shared-white-images/
  spec.md
  research.md
  plan.md
  data-model.md
  contracts/allocation.md
  contracts/delivery.md
  contracts/cutover-cleanup.md
  contracts/diagnostics.md
  quickstart.md
  tasks.md
  analysis.md
  validation/                 # майбутні sanitized acceptance artifacts
```

### Source Code (repository root)

```text
packages/shared/src/team/catalog-global-images.ts          # new contract3/guards
packages/shared/src/team/catalog-updater.ts                # history-only image fields
packages/shared/src/types.ts                               # closed failure reasons
supabase/migrations/20261208100000_catalog_global_pool.sql  # planned additive
supabase/migrations/20261208100100_catalog_global_cutover.sql
supabase/migrations/20261208100200_catalog_global_retirement.sql
supabase/functions/catalog-global-images/                  # new operator/worker/readiness API
supabase/functions/_shared/catalog-global-images.ts
supabase/functions/_shared/catalog-image-draw.ts
supabase/functions/_shared/catalog-image-rows.ts
supabase/functions/_shared/r2-catalog-images.ts
supabase/functions/catalog-images/{handler,worker}.ts
supabase/functions/drive-ops/{product-catalog,catalog-durable,launch-catalog,index}.ts
supabase/functions/catalog-updater/{index,worker,claim-preparation}.ts
apps/catalog-image-delivery/                               # new read-only Worker
apps/web/src/team/product-catalog/
apps/web/src/team/catalog-updater/
apps/web/src/team/launches/preparation.ts
apps/web/src/api/{team,team-catalog-images}.ts
scripts/analytics/{global-images,coverage-registry,code-map,schema,cli}.ts
scripts/catalog-global-operator.mjs                         # authenticated bounded operator tool
scripts/verify-catalog-global-provider.mjs                  # isolated fixtures only by default
scripts/benchmark-catalog-global.mjs
scripts/lib/release/catalog-global-cutover.mjs              # additive validated integration
scripts/verify-all.mjs
supabase/tests/database/catalog-global-*.test.sql
tests/catalog-global-*.test.ts(x)
```

**Structure Decision**: продовжити чинні seams045/047/031, не створювати ще один генератор каталогів, uploader для користувача чи dashboard. Нові таблиці потрібні для незалежного ownership і pair identity. Окремий Worker потрібен для fast public delivery без DB/Edge hop на кожне зображення; він не є користувацьким сайтом. Migration timestamps резервуються після поточної chain; T001 перевіряє конфлікти/нові migrations перед вибором.

## Phase 0 — Research decisions

[D01–D11](./research.md) закривають policy, slot/confirmed semantics, allocator, ready-ahead, delivery/cache, identities, retirement, T0/drain/rollback, UI/compatibility, release і diagnostics. Невідомі provider performance/Meta behavior — предмет acceptance, не привід вигадувати докази. Жодних невирішених product clarifications.

## Phase 1 — Data and contracts

[Data model](./data-model.md) визначає separate global identity й durable retirement. [Allocation](./contracts/allocation.md), [delivery](./contracts/delivery.md), [cutover/cleanup](./contracts/cutover-cleanup.md) та [diagnostics](./contracts/diagnostics.md) — єдині відповідні контракти. [Quickstart](./quickstart.md) — ізольований validation runbook.

1. Schema/guards/security seams готуються additive, feature inactive. Всі writers мають policy epoch і actor authorization.
2. Operator provision/import і read-only delivery проходять isolated positive proof; bootstrap2000 — fixture/load cohort, не обов’язок згенерувати files під час coding.
3. Global allocator входить у canonical Create/Launch/updater, не в parallel helper path. Stable catalog identity існує до resource freeze. Confirmation доповнює існуючий completion transaction; unknown має bounded reconciliation.
4. UI й compatibility fences готові до активації; старі image settings не повертаються через bulk undo, cached bundle або RPC. Prices/texts зберігаються, restitch image sources не чіпаються.
5. T0 preparation формує manifest і readiness/drain proof. Activation у звичайному authorized release workflow одноразово ставить epoch/T0/deadline. Наступні catalog writes тільки global. У next на prod даних T0 не активується автоматично.
6. До deadline retired copies read-only; після нього purge працює незалежно від import enable. Фізичне schema DROP не входить у фічу. Старий неоновлений каталог може втратити legacy managed image після grace.
7. Нові sanitized receipts і projections входять у CLI/inventory; runtime/DB/provider/browser/performance acceptance зберігає actual evidence окремо від design verdict.

## Ready-ahead and contention budgets

Asset content proof TTL24h and serving-health120s/probe<=60s govern eligibility. Alias identity proof does not expire daily; old pairs inherit fresh asset/config/key compatibility evidence without per-row GET. Current+2 are prepared ahead. Allocator uses indexed factual buckets, bounded scan, image locks50ms, statement750ms and caller deadline1s; same-intent busy returns pending promptly. Recheck pair under image lock before consuming slot.

За відсутності повного набору distinct картинок допустимі повтори ready images для незадоволених rows; pair slot витрачається один раз. Якщо жодної придатної/сумісної ready картинки немає — rollback allocation і fast failure. Після durable recipe commit дозволений лише exact replay; transport timeout має unknown, не новий seed/recipe.

Background: одна byte-heavy робота/invocation,≤60s, shared concurrency8; операторський import≤1000 files/5GB як045. Cleanup reuse існуючих8attempts/15min, остаточний unknown явний. Потрібен headroom benchmark цих limits, не бездоказова гарантія.

## Rollout and release constraints

Обов’язкова readiness matrix: new/old compatible client, hosted/installed macOS/Windows, Create/Launch/manual/scheduled/retry/growth, legacy false flag, text pairing, T0/grace/delete, diagnostic delivery, worker route/cache/proof. Не запускати broad production changes під guise mini release. Canonical runbook та051 status→next→promote лишаються обов’язковими.

Preparation/provisioning/activation tooling зберігає exact source/config/target proof і не містить credentials. Новий Worker підключається additive до trusted full release/provider adapter: read-only plan/check до explicitly authorized publication. Немає прямого wrangler deploy, автоматичних повідомлень, credential artifacts або зміни signing/version тут. Перед T0 rollback може скасувати preparation; після T0 rollback коду зберігає global fence й timer, а після cleanup не обіцяє recovery видалених байтів.

## Complexity Tracking

Винятків із constitution немає. New Worker/data tables — необхідна частина вимог прямого швидкого URL й shared ownership; існуючі schema/queues/contracts розширюються, а не замінюються. Усі сім journeys потрібні для production cutover; можна демонструвати US1 на ізольованому seed, але це не дозвіл активувати неповний MVP для всіх.

## Review prerequisites carried into implementation

Before T0 drain existing claimed purge/DELETE/CDN work as well as writes/import grants; unknown blocks activation. Manifest has managed object_purge and metadata-only unlink entries; zero-object spaces still finish settings cleanup. Ledger transfer uses current charged owner, never frozen original-owner credit. Cleanup_complete forbids unknown/blocked children.

Both current and archived prior rollback builds must implement active-policy/retired-settings barrier. If the current previous release lacks it, first deliver a separately validated compatibility baseline through the normal explicitly authorized workflow. No T0 until its proof exists. This document does not perform that release.
