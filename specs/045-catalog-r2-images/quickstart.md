# Validation guide — feature 045

Це acceptance-послідовність для реалізованої feature045. Фактично виконані перевірки та відкриті provider/runtime/release gates наведено у `validation.md`. Не позначати цю інструкцію виконаною без artifacts і реальних результатів.

## Prerequisites

- Ізольована feature checkout із актуальними spec/plan/tasks. Не включати чужі незакомічені зміни.
- Чинні Node/npm dependencies, Docker, local Supabase; `npm run beta:doctor` без production secrets/targets.
- Окремий R2 sandbox account/buckets: staging private, public sandbox media domain; environment-scoped credentials only in ignored runtime secrets. Ні bucket, ні media origin не production.
- Два тестові простори/акторів з owner, manage_metadata+download, view-only, revoked member. Local-only простір без Drive; другий з контрольним Drive і selected folder.
- Контрольний набір: 100 named square images; unknown names; ambiguous names; duplicated name/different bytes, duplicated bytes/different class; corrupt, animated, HTML, orientation, 16MP boundary, 50MB boundary; >1000 entry folder; sparse чорне худі+біла футболка.

## Static and targeted verification

Після відповідних test tasks, одним heavy child / nice 15 / один worker:

```bash
npm run build -w @video-compressor/shared
nice -n 15 npx vitest run tests/catalog-image-classification.test.ts tests/catalog-image-import.test.ts tests/catalog-image-publication.test.ts tests/catalog-image-selection.test.ts --maxWorkers=1
nice -n 15 npx vitest run tests/product-catalog-handler.test.ts tests/catalog-updater-worker.test.ts tests/apparel-texts.test.ts tests/product-catalog-settings-section.test.tsx tests/catalog-image-diagnostics.test.ts --maxWorkers=1
npm run test:db
npm run verify
```

Запускати послідовно; DB runner тільки disposable local clone, не remote URL. Якщо новий CLI diagnostic вимагає env, використовувати dedicated sandbox read-only analytics connection. Жодного ad-hoc SQL для analytics запитів.

## Acceptance matrix

| ID  | Сценарій                                             | Доказ успіху                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q01 | Drop 100 files, pick через клавіатуру/touch, CTA     | До CTA немає grants/uploads; visible stages; те саме без агента/Drive                                                                                                                                                                                    |
| Q02 | Drive folder із descendants і pagination             | dedup, bounded frozen candidates, explicit continuation; після browser close job добігає; gateway cron працює без user JWT тільки з named secret                                                                                                         |
| Q03 | Named/ordinary/mixed imports                         | matched facts або ready unclassified; unknown names не error; готові counts коректні                                                                                                                                                                     |
| Q04 | 32×24 filenames                                      | 768 matched pairs; tshirt special; ambiguous→unclassified; prompt version consistent                                                                                                                                                                     |
| Q05 | No-repeat/concurrent catalogs/retry                  | усі active ready entries у shuffle; same attempt не redraw; sparse pairs не вигадуються                                                                                                                                                                  |
| Q06 | Create, refresh, grow, refreshTexts=false            | shared pairing у всіх чотирьох комбінаціях прапорців; unknown/ambiguous/length-boundary custom text дає actionable conflict зі збереженням old catalog, canonical fallback тільки коли дозволено; generic без semantic guarantee; legacy fallback intact |
| Q07 | Duplicate identity conflicts                         | same bytes same class reused; same name different bytes distinct; conflicting class explicit refusal                                                                                                                                                     |
| Q08 | Staging replay після verify                          | final bytes/URL не змінені; жодного public browser grant; corrupt/oversize не published                                                                                                                                                                  |
| Q09 | Accepted PUT, reply lost; negative HEAD; stale lease | same-key conditional reconciliation; no false failure/new identity; stale commit rejected; orphan cleanup/adoption в обох lock order не руйнує ready URL                                                                                                 |
| Q10 | Origin/public readback mismatch; DB failure          | upload≠ready; кандидат має durable owner; старий каталог зберігається                                                                                                                                                                                    |
| Q11 | Cancel/revoke під час publish; reload local          | already-ready retained; stale candidate cleanup; delivered local adopted, недоставлені треба reselect; discovery без job ID; два abandoned jobs expire24h і звільняють reservations без видалення ready                                                  |
| Q12 | Removal/source deletion/uploader deletion/transfer   | issued URLs живі; actor sanitized; team-owned copies не прибрані                                                                                                                                                                                         |
| Q13 | Explicit revoke/team/draft delete                    | pre-cascade tombstone, eventual origin+own-CDN receipts, external cache unknown                                                                                                                                                                          |
| Q14 | Old browser/checkpoint + new server                  | v1 preserved тільки legacy/in-flight; new v1 work на v2 team upgrade-required before IO; fresh standalone/Launch v2 і persisted-version retries                                                                                                          |
| Q15 | Prompt click/keyboard/denied clipboard               | exact copy або manual fallback, short feedback; зовнішніх AI-запитів немає                                                                                                                                                                               |
| Q16 | View-only/cross-team/revoked actor/forged worker     | жодної недозволеної mutation/publication; no sensitive projection                                                                                                                                                                                        |
| Q17 | Missing/late/rejected telemetry                      | read-only CLI пояснює стан через authoritative receipts; explicit blind spot, не success                                                                                                                                                                 |
| Q18 | Quota/reservation/expired/replayed grant             | no double reserve; limits enforced on publication, staging exposure measured separately                                                                                                                                                                  |
| Q19 | 50MB /16MP supported worst cases                     | aggregate peak memory ≤192MB при concurrent requests до одного isolate, CPU≤1.5s/invocation, nonblocking isolate permit/busy requeue; overlimit deterministic rejection                                                                                  |
| Q20 | 25k dictionary /1000 drop                            | first-page/status p95≤2s; exact total/hasMore; no recurring polling; UI responsive                                                                                                                                                                       |
| Q21 | Public media formats і actual importer               | anonymous hash/type/nosniff header readback + окреме прийняття контрольного фіда зовнішнім імпортером                                                                                                                                                    |
| Q22 | Rollout disabled/import disabled/selection disabled  | no new forbidden work; existing ready URL and historical checkpoint readers retained                                                                                                                                                                     |

## Diagnostic validation

Для кожного ін'єктованого failure отримати safe import/attempt ID і виконати команди через наявний CLI:

```bash
npm run analytics -- catalog-images <import-id> --period 7d --as-of <fixed-iso> --json
npm run analytics -- inspect <attempt-id> --json
npm run analytics -- investigate <test-subject-id> --as-of <fixed-iso> --json
npm run analytics -- audit --as-of <fixed-iso> --json
```

Підставити реальні тестові IDs/ISO, не копіювати placeholders буквально. Перевірити last-proven-stage, stable cause або insufficient, лаг/freshness/знаменники. Beta не надсилає production analytics: тестовий read-only fixture/projection suite доводить CLI, локальні sanitized receipts і UI artifacts доводять beta path; не вмикати production telemetry, щоб «зібрати доказ».

Перевірити відсутність URL, staging grants, source filenames, content hash, prompt text/clipboard і raw provider errors в telemetry, CLI export та перевірених logs. No production credentials/data.

## Evidence and release

Зберегти результати, fixture digests без приватних назв, точні commands/build/SHA, resource measurements, browser/OS matrix, diagnosis outputs і missing coverage у `specs/045-catalog-r2-images/validation.md` (створюється реалізаційною таскою). Це відрізняє authored plan від виконаного product acceptance.

Після targeted checks — `npm run verify:release`, канонічна ізольована packaged beta exact commit і ручне приймання importer. Read `docs/PRODUCTION.md` перед будь-яким майбутнім release; functions/DB/shared виключають web mini. Backend additive/disabled → new clients → explicit activation; imports-off не видаляє ready bytes. Production commands не запускаються під час цієї реалізації.
