# Quickstart: перевірка реалізації плану 036

Це інструкція для етапу виконання. Нові acceptance scripts та recovery ще не реалізовані. Наявні команди нижче можна виконувати після підготовки виділеного стенду; відсутній засіб дає BLOCKED, не заміну ручним production SQL.

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

Після реалізації tooling виконати `preflight` і `fixture apply` за [контрактом](contracts/acceptance-tooling.md), записати campaign manifest. Немає нового CLI — цей крок BLOCKED. Відкрити два Safari profiles і Chrome за [runbook](runbook.md), пройти SET-001–008.

## 2. Довести автоматичне відновлення

1. W1: три каталоги — два з різними активними інтервалами, один вимкнений вручну. Додати одну незавершену recoverable agent operation та одну скасовану.
2. Перевірити owner-only попередження через справжній renderer/capture на D−3/D−1/D+1; billing mail не повинен піти назовні.
3. Перейти через D+4 локальним tariff clock fixture. Прямі read/write/claim від A/B/C мають відхилятись; збереження даних підтвердити контрольним manifest, а не доступом користувача через blocked gateway.
4. Зареєструвати scoped background agent із чинними правами. Закрити всі browser workload tabs. У S admin context поновити строк.
5. Перевірити durable intent ≤60 с; перший прохід кожного попередньо активного каталогу ≤5 хв за доступних залежностей. Вимкнений каталог і user-cancelled job не стартують. Агентна робота виконується без вкладки, тільки за чинною делегацією.
6. Повернути A/B/C: коректний стан, дані й права. Повторити з offline agent, needs_reauth, manual stop race, double renewal та worker crash. Partial/waiting показано правдиво; CLI пояснює кожен ресурс.
7. Виконати LIFE-013/014/020–036 із каталогу й пов’язані ACL/SYNC регресії. Зняти clock/fault overlay, перевірити teardown.

## 3. Автоматичні перевірки

Наявні suites, які потрібно розширити та запустити після реалізації:

```bash
npm run build -w @video-compressor/shared
npx vitest run tests/space-tariffs-sql.test.ts tests/space-tariffs-contract.test.ts tests/tariff-notices.test.ts tests/team-catalog-updater-sql.test.ts tests/team-bridge.test.ts --maxWorkers=1 --minWorkers=1
npm run test:db
npm run verify
```

Нові recovery/fixture/agent tests також запускати single-worker за їхніми фактичними назвами. PGlite успіх не замінює реальну SQL concurrency/RLS перевірку. За failure виправити причину й повторити affected gate, не приховувати skipped integrations.

## 4. Ручна та ресурсна прийомка

Виконати всі 174 кейси за runbook, потім LOAD-01–10 за [capacity-plan](capacity-plan.md) з реалізованим harness та native browser probes для SC-003. Перед hosted LOAD виконати запропоновані `hosted prepare` і `hosted verify`: перевірити candidate migration/function/web hashes, scheduler, Realtime та diagnostic ingestion. Hosted ресурсні докази лише на окремому verified acceptance target; локальні таймінги не доводять Free quotas. Щонайменше одна 8-годинна витримка, backup/restore і Windows evidence.

Діагностика: `npm run analytics -- investigate <test-email> --json`, `inspect <id>`, `sync <team-id>`, `audit --period today --json`, `database-retention --json`; спочатку target verification. Для browser beta events потрібен новий local capture sink: звичайна beta analytics вимкнена. Management metrics без explicit acceptance binding не використовувати як доказ тестового стенду.

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
