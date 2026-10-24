# Recovery034 → acceptance036: перевірка чинної реалізації

Це mapping аудиту, не нове виконання manual LIFE/TARIFF cases. Власник передав single-user UI перевірки собі; тут використовуються чинний source та автоматичні regression proofs. Повна036 лишається NO_GO.

## T024 — SQL regression audit: завершено2026-10-21

Canonical172-file release22/22 PASS: `space-tariffs-sql.test.ts`47/47 PASS та `team-catalog-updater-sql.test.ts`28/28 PASS, без skips. Це embedded PostgreSQL/PGlite full-chain fixture; окремий real PostgreSQL/Vault proof належить T025. Source/test hashes незмінні від canonical run. Machine-readable mapping: release/acceptance/acceptance-036-20261020/recovery-audit-t024-20261021.json.

| Вимога T024                 | Перевірене твердження                                                                                                                                                     | Джерело                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Mixed schedules             | Hourly/daily незалежні; відкривається лише due catalog; daily/weekly профілі й civil schedule збережено після renewal                                                     | tests/team-catalog-updater-sql.test.ts:921; tests/space-tariffs-sql.test.ts:1130 |
| Renewal без UI              | admin Undo без браузера створює reconciliation та відновлює updater до compatibility resume; читання tariff projection показує pause=false                                | tests/space-tariffs-sql.test.ts:1022;1130                                        |
| Repeated renewal            | Друге extend + compatibility resume + open rounds не змінює first round/next run                                                                                          | tests/space-tariffs-sql.test.ts:1130                                             |
| Expiry до cron              | Direct fixture date expiry без pause sweep, потім extend відновлює тільки enabled recurring; disabled не повертається                                                     | tests/space-tariffs-sql.test.ts:1130                                             |
| Manual stop                 | Late sweep після renewal не зупиняє updater; подальший explicit stop не відновлюється compatibility resume                                                                | tests/space-tariffs-sql.test.ts:1214                                             |
| One-off durable             | Незмінні attempt/round до pause, після повторного sweep та renewal; update_interval лишається null; completed≠delivered явно unknown                                      | tests/space-tariffs-sql.test.ts:1238                                             |
| Blocked housekeeping        | У suspended state sync/preview/archive/copy claims=0, retired copy збережена; після reopen claims знову можливі                                                           | tests/space-tariffs-sql.test.ts:1571                                             |
| Current dependencies/rights | Drive needs_reauth → waiting_drive, відновлення після connected; видалений author → permission_revoked без повернення old round                                           | tests/space-tariffs-sql.test.ts:1451;1498                                        |
| Capture-before-clear        | apply_tariff_pauses блокує tariff/updater, rechecks gate, capture_workspace_pause перед очищенням live intervals/rounds; dispatch перевіряє generation/current permission | supabase/migrations/20261205110000_tariff_recovery.sql:77;124;190                |

Нової прогалини в перелічених T024 SQL твердженнях не знайдено; дублюючих тестів і другої recovery реалізації не додано. Це не доказ browserless native execution ≤5min, concurrent PostgreSQL locks чи доставки зовнішнього Drive результату: вони залишаються окремими задачами.

## T026 — delegation/protocol boundary audit: завершено2026-10-21

Після canonical handoff додано6 regression variants до чинних2 файлів, без змін product/schema. Current focused23/23 PASS:14 delegation +9 handler. Test typecheck і touched lint PASS. Нові cases пройшли з першого запуску на чинній реалізації: runtime defect/red fix не вигадувався. Це локальні PGlite/protocol/auth seams, не live GoTrue/Windows/Keychain або final acceptance PASS.

| Вимога                   | Прямий доказ                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant                   | Unrelated open tenant не допускає enrollment і не створює challenge: delegation:294                                                                                                                                                                  |
| Installation/actor       | Setup замінює лише exact actor+installation; інший device живий. Чужий admin revoke не анулює owner handles; owner revoke діє лише на вибраний device: delegation:312                                                                                |
| Enrollment120s/once      | Новий challenge expiry лежить у bracket120s DB clock; прострочений redeem відхиляється без consumed_at/refresh. One-time/wrong ticket: delegation:255;63                                                                                             |
| Credential/family expiry | Expired claim відхиляється; expired parent delegation блокує ще live claim і refresh probe: delegation:171;378                                                                                                                                       |
| Rotation/replay          | Lost reply повертає exact stored response. Інший rotation ID зі старим handle анулює family. Persisted replay TTL60s/claim300s перевірені; після replay expiry відхиляється навіть той самий rotation ID та анулюється family: delegation:85;102;352 |
| Revoked member/process   | Remove/re-add під suspended tariff не повертає handle; process override false→clear не повертає handle: delegation:197; lifecycle revocation triggers                                                                                                |
| Issuance/auth boundary   | Browser SQL roles не мають RPC execute; handler відхиляє browser credential actions; delegate actor береться з authorizeCaller, bearer без resolved user не доходить до RPC: delegation:247; handler:38;45;66                                        |
| Claim/execute audiences  | Refresh не claim, claim не settle, execute не claim; exact operation/job/epoch fences та tariff closure: delegation:85;136                                                                                                                           |
| Receipt boundary         | Pending/unknown terminal і success без durable output не settle; durable output завершує існуючу job, claim replay не створює нової: handler:82;90;101;112                                                                                           |

Посилання `delegation:N` — tests/team-recovery-delegation.test.ts:N; `handler:N` — tests/team-recovery-handler.test.ts:N. Чинна source перевірка: supabase/migrations/20261206100000_team_recovery_delegation.sql,20261206110000_recovery_lifecycle.sql, supabase/functions/team-recovery/{index,handler}.ts та _shared/auth.ts. Service-role RPC використовується trusted Edge adapter; user-facing delegate вимагає resolved Auth user, service key сам по собі не є user. Mocked no-user Auth result не видається за реальний запит до GoTrue.

Цей tests-only increment не входить у попередні6525 canonical tests; останній full PASS залишається прив’язаним до frozen172 candidate. Test count не додається до historical full results. Докази: recovery-audit-t026-complete-20261021.log, complete-typecheck/complete-eslint logs та recovery-audit-t026-evidence-20261021.json у release/acceptance/acceptance-036-20261020/.

## T027 — historical checkpoint (superseded below)

Чинні10 worker і2 journal tests доводять uncertain restart no replay, durable metadata/corrupt input rejection, output receipt before settle, Retry-After/episode ceiling/probe persistence across restart. Окремі cancellation/permanent terminal restart та governor/native process cancellation assertions ще не зіставлено; task лишається відкритою. Це відсутність достатнього доказу, не встановлений runtime defect.


## Історична зупинка за вказівкою власника —2026-10-21

За прямою вказівкою власника перевіряти лише двох користувачів і зупинитися: доступні F2-01–10 PASS, F2-11/12 BLOCKED(Test Drive). Single-user перевірки передано за owner-ui-checklist.md. Подальшу повну036 не продовжувати без нового запиту. T027 retry/backoff defect відтворено, незавершений increment збережено приватно й4 source/test files повернуто до pre-audit стану. Цей fix не застосований і не зарахований як завершений; продукт відповідає canonical172 PASS, T026 tests-only increment23/23 залишено. Повна036 NO_GO.


## T027 — відновлено за наступним дорученням власника2026-10-22

Наступні явні доручення знову дозволили всю доступну автономну036 роботу. Перед відновленням перевірено SHA256 всіх чотирьох parked baseline files; вони збігалися. Спочатку повернуто лише regression tests:10RED/20PASS. Runtime fix зберігає serverRetryNotBefore окремо від локальної cooldown, перевіряє збережений deadline перед network tick та не дозволяє explicit retry обійти серверний floor. Старий журнал без нового поля читається; невідомий тип deadline консервативно зберігається. Окремі zero/positive floor roundtrip і malformed input перевірено.

Worker/journal32PASS плюс handler9/platformcredentials13/providerworker22/conditionalclient17 =93PASS. Прямі protocol cases підтверджують succeeded/canceled/failed settle без повторного process після restart, permanent errors без retry,3episodes ceiling і preserved requestID. Existing TeamProcessBridge cancellation проходить hold→resume→abort, cleanup once, no output upload і registration removal без replay. Це bridge/governor contract; реальний Windows і5-minute native SLO залишаються окремо. Докази: drive-followup/t027-restored-red.log, t027-restored-green.log, t027-expanded-regression.log. Final canonical proof pending.


## T036/T037 — current local proof2026-10-22

T036 has actual macOS synthetic Keychain roundtrip/replacement/ownedcleanup plus13automated cross-platform storage contracts. Windows native host remains unavailable. T037 now uses a durable one-time server reservation before checkpoint acknowledgement; the old public RPC is fenced too, and its private core is not service-callable.353chain877pgTAP/35files+10nativePASS; concurrent starts get true/false once. Actual Edge duplicate409 and real-worker syntheticaccepted rewind produce blocked checkpoint_unavailable/processCalls0. The immutable read-only reservation receipt is distinct from native start or delivery; both remain unknown from that receipt. Local353 and official restart preserve auth/Drive; generated types refreshed. No physical power-loss test, native Windows execution or final whole-suite result is inferred. T048 remains open.
