# Generation, progress, recovery, cancel

## Один намір

Generate зберігає immutable input, request digest та logical generation ID перед зовнішнім IO. Parent generation не замінює team_operations: child IDs зберігаються як dependencies. Lease/fence визначає поточного executor; перенесення ownership не запускає нову роботу, поки старий outcome не з'ясований.

Кроки:

| Stage              | Evidence завершення                              | Retry                                          |
| ------------------ | ------------------------------------------------ | ---------------------------------------------- |
| accepted/validated | server intent + snapshots committed              | replay того самого key                         |
| text_derived       | pure names/URL/budgets/ranges persisted          | deterministic, без provider IO                 |
| restitch_preparing | defaults, selected screens, source version saved | відновити snapshot; не змінювати random choice |
| restitch_running   | child operation прийнята, SSE stage progress     | attach до child; не restart лише через reload  |
| restitch_finalized | succeeded child + ready material + version       | reuse якщо inputs/material придатні            |
| catalog_planned    | reserved variant, immutable rows, operation key  | повернути reservation                          |
| catalog_created    | provider intent marker/file ID доведені          | reconcile uncertain response                   |
| catalog_registered | finalized material + catalog association         | завершити link, не новий file                  |
| result_committed   | parent CAS active revision                       | replay result                                  |
| result_visible     | client renders committed revision                | telemetry evidence, не server success gate     |

`other` проходить accepted/text_derived/result_committed; швидка операція може показувати лише «Готуємо запуск…» → результат. Не додавати фіктивний sleep. Catalog без restitch пропускає його stages.

## Progress DTO

Generation snapshot має state, stage, stageStatus, stageUpdatedAt, stateVersion, completedStages, childOperationIds. Numeric progress — nullable `{completed,total,unit,source}` тільки для виміряного stage, наприклад bytes або rows. FFmpeg відсоток описує процес перезашивки, не всі наступні uploads. Немає довільно зваженого загального процента. Invalid/stale progress не відкатує settled stage.

Local: existing agent SSE owner. Hosted: existing authorized team Realtime invalidation seam → bounded authoritative read. Initial/reconnect/foreground reads обов'язкові. Жодного нового recurring browser polling/heartbeat loop для показу progress. Heartbeat робочого executor — orchestration, не UI progress transport, має lease/fence та bounded retry.

## Catalog identity/reconciliation

Почати/resume logical operation до nextVariant/randomness/sharing. Unique reservation на video+variant і operation ID. Existing UI calls і Launch adapter проходять один reservation механізм.

Drive create має stable appProperties operation marker; persisted intent перед create, provider file ID одразу після. Lost response → bounded marker lookup у правильному credential/parent scope. Negative lookup не завжди доводить відсутність файлу: до доказу outcome interrupted, без blind recreate. Після знайденого output перевірити owner/mime/expected parent/registration і продовжити finalize/link.

Finalize матеріалу вже може поставити child succeeded; parent ще не ready до catalog link. Старий executor із втраченим fence не може комітити link/publication; його створений output потрапляє до ownership-aware reconciliation.

## Cancel contract

Після Generate lock config/meta/manual override/archive mutations для цього Launch. Cancel відправляє parent cancel_requested, revoke/stop children, fence publication. UI показує «Скасовуємо…», чекає authoritative settlement. Closing tab не є cancel.

Після припинення children і cleanup: canceled, unlock, restore prior active result; для first generation показати той самий draft. Candidate result не публікується. `failed` не стирає old result, але retry виконує лише незавершені stages.

Cleanup має видаляти лише owned unpublished outputs. Catalog/archive resources, початковий material, reused restitch, попередні revisions не видаляються. Sharing permission, доданий цією generation, відкочується лише за записаного permission ID і доведеної відсутності інших consumers; чужий/раніше наявний anyone-reader доступ не змінюється. Якщо ownership або outcome сумнівний — canceled_with_cleanup_pending/interrupted із safe evidence, не обіцянка повного rollback.

Race правило: success commit до cancel → повернути completed; cancel accepted до commit → publication denied. Atomic rows/fence виконують це і при двох вкладках/reload. Settled canceled generation не відновлюється автоматично.

## Діагностика

Typed lifecycle flow → generation → attempt → child operation; stage/terminal/cleanup/visible evidence. CLI inspect/investigate показує останній доведений етап, залежність і safe cause; audit виявляє missing joins/terminals/visibility. Не логувати config/URL/names/SUB values/permission tokens. Synthetic secret redaction перевіряється через producer, guard, persistence та CLI, не лише в одній frontend функції.

## Hosted recovery без відкритого клієнта

Розширити не тільки `catalog-updater/worker.ts`, а й wiring dependencies в `catalog-updater/index.ts` та SQL `private.invoke_catalog_updater_worker`. Наявна функція (міграція `20261127100000_restitch_cache_cleanup.sql`) пробуджує worker за catalog updater/retired-copy роботою; Launch due work має бути самостійною умовою виклику. Додати additive migration `20261201113500_launch_recovery_dispatch.sql` з rollback notes: due recovery/cleanup, bounded claims, lease/fence, next_attempt_at/backoff та індекси. Наявний auth/secret dispatch і scheduler повторно використовуються; saturation старої catalog черги не повинна безстроково блокувати Launch cleanup — окремий bounded claim budget і справедливе обслуговування.

Worker відновлює тільки вже прийнятий intent: reconcile неопевненого provider output, commit доведеного результату або owned cleanup. Не починати нову generation й не повторювати доведено failed stage без explicit resume. Settled canceled intent не відновлюється. waiting_dependency без доступного агента не стартує server FFmpeg і не створює busy-loop. Закрита вкладка й відсутність scheduled catalogs не заважають завершити допустиму серверну роботу; reconnect лише читає її authoritative результат.

Обов’язковий integration case: у БД лише один due Launch recovery/cleanup, жодного updater item/retired copy, вкладки закриті → SQL dispatch викликає endpoint, той claim-ить саме Launch, просуває/settle-ить стан; повторний tick не дублює output. Відсутність worker credentials дає діагностовану недоступність, а не удаваний успіх.
