> **Current scope decision — 2026-10-24:** 036 is CLOSED for completed local implementation and verification. Remaining substantial acceptance obligations are OPEN in [042 Production Readiness](../042-production-readiness/spec.md), with exact mapping in [scope-transfer.json](scope-transfer.json). See [closure.md](closure.md). Earlier full-campaign requirements and NO_GO checkpoints below are retained as historical requirements/evidence for 042; no production GO or test PASS is inferred from this scope change.

> Рішення власника 2026-10-23: продовжувати до завершення всього доступного обсягу; нативну перевірку Windows виключено через відсутність реального пристрою. Канон виключення — [acceptance-policy.json](acceptance-policy.json), scope `native-windows-runtime`, case REG-017 і лише Windows-частини T059/T173. Це не PASS і не доказ Windows-сумісності. Unit/contract/build перевірки підтримуваних платформ та macOS multi-device залишаються обов’язковими. Інші зовнішні передумови й невиконані перевірки зберігають власний статус.

> Поточний ручний пріоритет за рішенням власника 2026-10-21: агент перевіряє лише взаємодію двох користувачів за [two-user-focus.md](two-user-focus.md); однокористувацькі екрани передано власнику за [owner-ui-checklist.md](owner-ui-checklist.md). Історичні 174 кейси зберігаються, невиконане не перетворюється на PASS/N/A. Автоматичні регресії залишаються агенту.

> Оновлення 2026-10-21: реалізовані локальні команди наведено нижче. Інші запропоновані команди у цьому документі не слід вважати доступними, доки CLI явно їх не підтримує.

# Quickstart: перевірка реалізації плану 036

Це інструкція для етапу виконання. Recovery уже реалізовано в 034; у 036 перевіряється його відповідність поточному кандидату. Частину local acceptance tooling реалізовано (команди нижче), але clock/fault/mail capture, повний load/hosted harness і campaign adoption лишаються відкритими. Відсутній засіб дає BLOCKED, не заміну ручним production SQL.

## Передумови

Node 22, Docker/Colima, Supabase CLI, потрібні media binaries, test Google Drive, два Safari profiles й Chrome, окремі A/B/C та Soty admin, Windows/другий агент для відповідних кейсів. Чистий кандидат потрібний для final; початковий дослідний прогін може мати explicit dirty manifest. Не зупиняти активну чужу роботу для підготовки.

## 1. Локальний стенд

```bash
npm run beta:doctor
```

Doctor має пройти isolation/prerequisites. Для виділеної тестової beta після нових міграцій зберегти потрібні тестові дані, потім:

```bash
npm run beta:reset
npm run beta:up
```

Reset має локальні руйнівні ефекти за docs/BETA.md. Не запускати його на стенді з незбереженою потрібною роботою. Перевірити health, schema і web/agent identity.

Виконати реалізовані local `preflight` і `fixture apply` за [контрактом](contracts/acceptance-tooling.md), записати campaign manifest. Немає нового CLI — цей крок BLOCKED. Відкрити два Safari profiles і Chrome за [runbook](runbook.md), пройти SET-001–008.

## 2. Довести автоматичне відновлення

1. W1: три каталоги — два з різними активними інтервалами, один вимкнений вручну. Додати одну незавершену recoverable agent operation та одну скасовану.
2. Перевірити owner-only попередження через справжній renderer/capture на D−3/D−1/D+1; billing mail не повинен піти назовні.
3. Перейти через D+4 локальним tariff clock fixture. Прямі read/write/claim від A/B/C мають відхилятись; збереження даних підтвердити контрольним manifest, а не доступом користувача через blocked gateway.
4. Зареєструвати scoped background agent із чинними правами. Закрити всі browser workload tabs. У S admin context поновити строк.
5. Перевірити durable intent ≤60 с; перший прохід кожного попередньо активного каталогу ≤5 хв за доступних залежностей. Вимкнений каталог і user-cancelled job не стартують. Агентна робота виконується без вкладки, тільки за чинною делегацією.
6. Повернути A/B/C: коректний стан, дані й права. Повторити з offline agent, needs_reauth, manual stop race, double renewal та worker crash. Partial/waiting показано правдиво; CLI пояснює кожен ресурс.
7. Виконати LIFE-013/014/020–036 із каталогу й пов’язані ACL/SYNC регресії. Зняти clock/fault overlay, перевірити teardown.

## 3. Автоматичні перевірки

Наявні suites для аудиту та повторної перевірки; розширювати їх лише для виявлених прогалин:

```bash
npm run build -w @video-compressor/shared
npx vitest run tests/space-tariffs-sql.test.ts tests/space-tariffs-contract.test.ts tests/tariff-notices.test.ts tests/team-catalog-updater-sql.test.ts tests/team-bridge.test.ts --maxWorkers=1 --minWorkers=1
npm run test:db
npm run verify
```

Нові recovery/fixture/agent tests також запускати single-worker за їхніми фактичними назвами. PGlite успіх не замінює реальну SQL concurrency/RLS перевірку. За failure виправити причину й повторити affected gate, не приховувати skipped integrations.

## 4. Ручна та ресурсна прийомка

Виконати всі 174 кейси за runbook, потім LOAD-01–10 за [capacity-plan](capacity-plan.md) з реалізованим harness та native browser probes для SC-003. Перед hosted LOAD виконати запропоновані `hosted prepare` і `hosted verify`: перевірити candidate migration/function/web hashes, scheduler, Realtime та diagnostic ingestion. Hosted ресурсні докази лише на окремому verified acceptance target; локальні таймінги не доводять Free quotas. Щонайменше одна 8-годинна витримка, backup/restore і Windows evidence.

Діагностика: `npm run analytics -- investigate <test-email> --json`, `inspect <id>`, `sync <team-id>`, `audit --period today --json`, `database-retention --json`; спочатку target verification. Для browser beta events реалізовано окремий DEV-only local capture sink; звичайна beta analytics вимкнена. Management metrics без explicit acceptance binding не використовувати як доказ тестового стенду.

## 5. Остаточний кандидат

Після виправлень зафіксувати clean SHA та актуальні types/schema/artifacts, повторити критичну регресію. Послідовно:

```bash
npm run verify:release
npm run beta:down
npm run beta:package
npm run beta:verify
```

Звірити exact SHA/digests, стандартний verification-result і packaged record. Заповнити [execution report](execution-report.md) з case totals, SC-001–007/FR-016, ресурсними прогнозами, невідомими величинами та GO/NO-GO. Досягнення GO не запускає production; далі діє docs/PRODUCTION.md.

Після зміни SHA застосувати EvidenceAdoption тільки до дозволених незалежних P1 за data-model §5a. P0, security/tariff/recovery, performance/LOAD, backup, Windows credentials/recovery та package виконуються заново на фінальному SHA. Контрольні кейси: expiry → snapshot → restart до оплати → renewal; роль знижено під час паузи; claim token не може settle і навпаки.

## Реалізований development tooling

Private target manifest має strict local beta origins/ports і namespace `acceptance-*`; DSN/credentials не копіюються в evidence. Запускати з worktree, який володіє перевіреним local Supabase project; namespaces старого й свіжого стендів не взаємозамінні.

```bash
node scripts/acceptance/cli.mjs validate-target <private-target.json>
node scripts/acceptance/cli.mjs fixture apply <private-target.json>
node scripts/acceptance/cli.mjs fixture variants <private-target.json>
node scripts/acceptance/cli.mjs preflight <private-target.json>
node scripts/acceptance/cli.mjs login-page <private-target.json>
node scripts/acceptance/cli.mjs smoke <private-target.json>
node scripts/acceptance/cli.mjs tariff-smoke <private-target.json>
node scripts/acceptance/cli.mjs media <private-target.json>
node scripts/acceptance/cli.mjs diagnose <private-target.json> investigate C
node scripts/acceptance/cli.mjs diagnose <private-target.json> audit
node scripts/acceptance/cli.mjs calibrate <private-target.json>
node scripts/acceptance/cli.mjs calibrate-realtime <private-target.json> steady
node scripts/acceptance/cli.mjs calibrate-realtime <private-target.json> burst
node scripts/acceptance/cli.mjs fixture clear <private-target.json> --dry-run
node scripts/acceptance/cli.mjs record release/acceptance/<campaign-id> <manifest.json> <record.json>
node scripts/acceptance/cli.mjs report release/acceptance/<campaign-id> <manifest.json>
```

Generated login URL: `http://127.0.0.1:5175/acceptance-login.html`. Вводити тільки synthetic credentials із private fixture registry у своїх browser profiles; звичайний beta Auth залишається реальним. Прибрати generated page перед final packaging.

Перед першим `record` збережіть перевірений `manifest.json` усередині нової campaign directory; переданий CLI manifest має збігатися з ним. Writer атомарно створює `manifest.frozen.json` і записує його SHA-256 у кожен новий run. Зміна scope/fixture/config або видалення snapshot відхиляється. Історичні development campaigns без snapshot читаються explicit `legacy_unfrozen`, але append/final для них заборонений: створіть нову campaign, не переписуйте старі докази.

Record storage: `runs/<runId>.json`, atomic immutable publication; artifact checksums перевіряються при записі та report. Report не видає фінальний GO: required variants, hosted load, backup і packaged exact-SHA лишаються окремими gates. Невідомі commands/flags відхиляються; відсутній load/clock/fault/hosted/adoption не маскується успіхом.

Calibration — 330 offered account reads, A/B/C real Auth, explicit warmup/concurrency/timeouts;
це API-only development measurement, не LOAD-01 і не UI/hosted capacity proof. Read-only diagnose
явно прив'язаний до local target; management credentials і production fallback не використовуються.
Function readiness вимагає structured application error, сам HTTP 403/CORS не є доказом.

`fixture variants` додає окремі SOLO/PENDING identities і bound Solo / pending unbound / legacy
spaces; legacy rule мусить бути вже активним, команда його не змінює. Exact state drift відхиляється.
`fixture clear <private-target.json>` працює тільки для доведеного empty graph, без provider calls.
Content/audit/history/Storage/unknown references блокують cleanup до записів. Durable private checkpoint
розрізняє app-disabled/Auth-pending та complete; після втраченої відповіді повторити ту саму команду.
Checkpoint зберігається і блокує повторне provisioning цього namespace. Не видаляти його для обходу.

Realtime calibration: 5 окремих реальних Auth clients/channels, три дозволені readbacks та X/S
non-member listeners. Кожен профіль має 10 warmup + 100 measured creates, concurrency 4, deadline15s;
steady=1 write/s, burst=5 writes/s. HTTP acknowledgement і signal самі не означають delivered:
потрібний matching result ID/name у наступному authorized read. Dropped/missing/late включено
у denominator, teardown перевіряє channels і connections. Це локальний protocol calibration;
не запускати його паралельно з canonical verify для baseline performance. Різні profiles
мають різні evidence files; PASS steady не замінює FAIL burst. Native DOM/hosted/soak лишаються окремими.

DEV login helper має `Use current synthetic session`: Auth `getUser` перевіряє чинну сесію, existing namespace guard допускає лише campaign fixture. Це відновлює local capture після reboot без password entry; не створює сесію і не обходить Auth. Не-synthetic/інший namespace відхиляється.

## Після cleanup2026-10-21

Acceptance runtime зупинений штатно; початковий mutable Soty Beta повернений із preserved directory. Fresh synthetic state заархівовано, DB volumesacceptance036 збережені. Не запускати isolated worktree beta:up без повторної app-support ізоляції за runbook: поточний Soty Beta знову є початковими даними власника. Не запускати/мігрувати старий wishly автоматично. Для повторного запуску потрібні вільні beta порти й окреме збереження original state; shared model/runtime assets залишаються початковими, без копіювання приватних credentials.

Google Picker public config відновлено з GitHub repository variables за docs/PRODUCTION.md, лише у приватному env acceptance worktree. Canonical environment 2/2 та повторний e2e 8/8 PASS; ROOT env не змінено. Test Drive F2-11/12 досі не підключений.
