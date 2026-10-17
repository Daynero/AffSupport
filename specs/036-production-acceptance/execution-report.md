# Форма звіту прийомки

**Стан: NOT RUN. Рішення про production: не надано.** Копіювати цю форму для кожної кампанії; не перетворювати відсутні результати на PASS.

## Кандидат і стенд

- Campaign ID, відповідальний, UTC початку/кінця:
- Base tag/SHA; candidate SHA; clean/dirty; artifact digests:
- Web/agent/protocol versions; backend migrations/function revisions:
- macOS/Safari/Chrome/Windows версії; профілі/агенти:
- Fixture ID, контрольний manifest даних, clock/fault fixture версія:
- Локальний чи hosted стенд, план/compute, інші споживачі квот:
- Scope diff проти попереднього прогону та причини N/A:

## Виконання

Кожен із 174 ID має щонайменше один рядок. Перестановка браузерів/фаза/профіль створює новий рядок з тим самим ID й окремим Run ID. Порожній рядок не рахується виконанням.

| Case ID / Run ID | Роль / браузер / fixture | Час UTC | Фактичний результат | PASS / FAIL / BLOCKED / NOT RUN / N/A | Доказ / correlation IDs | Defect ID / повтор |
| ---------------- | ------------------------ | ------- | ------------------- | ------------------------------------- | ----------------------- | ------------------ |
| —                | —                        | —       | Не виконано         | NOT RUN                               | —                       | —                  |

## Дефекти

| ID  | Severity | Кейс / кандидат | Очікуване → фактичне | Відтворення | Останній доведений етап / причина / unknown | Власник | Fix SHA | Повтор і залежна регресія |
| --- | -------- | --------------- | -------------------- | ----------- | ------------------------------------------- | ------- | ------- | ------------------------- |
| —   | —        | —               | —                    | —           | —                                           | —       | —       | —                         |

Severity: S0 — втрата/витік даних або обхід доступу; S1 — тариф/команда/sync/ключова операція не працює; S2 — обхідний шлях існує, не зачіпає даних/прав; S3 — косметика. S0/S1 блокують продажі. Критичний BLOCKED або NOT RUN також блокує, навіть без зареєстрованого багу. S2/S3 потребують явного рішення власника продукту, строку виправлення та відсутності порушених критеріїв.

## Ресурси

| LOAD ID | Люди / команди / вкладки | Дані / тривалість | p95 / errors / sync delivery | CPU / RAM / IO / DB pool | Monthly квоти / DB growth | Recovery | Джерела / unknown |
| ------- | ------------------------ | ----------------- | ---------------------------- | ------------------------ | ------------------------- | -------- | ----------------- |
| —       | —                        | —                 | —                            | —                        | —                         | —        | —                 |

| Ресурс | Поточний вимір і UTC | 30/90-денний прогноз | Квота / запас | Free verdict | Найменший перевірений план | Вартість та припущення |
| ------ | -------------------- | -------------------- | ------------- | ------------ | -------------------------- | ---------------------- |
| —      | —                    | —                    | —             | Не доведено  | Не перевірено              | —                      |

## Остаточне рішення

- Кількість PASS / FAIL / BLOCKED / NOT RUN / N/A окремо за P0/P1; сума дорівнює затвердженому scope.
- Всі зміни manifest мають доказ або обґрунтоване виключення.
- SC-001…SC-007: фактичний вимір і посилання на доказ для кожного.
- Відкриті дефекти та сліпі зони; прийняті S2/S3 з відповідальним.
- `verification-result.json`, Windows-доказ, exact-SHA packaged beta record.
- Backup/restore: час копії, відновлення, звірка даних/прав, досягнуті RPO/RTO.
- Рішення Free/Pro/compute та невідомі метрики; відповідальний за моніторинг перших 14 днів.
- GO / NO-GO, підпис власника продукту, дата. GO прийомки не підміняє G0, sandbox evidence і canonical production release gates.

## Додаткові докази після аналізу

- Recovery: pause_id/pause_epoch, snapshot до renewal, restart proof; актуальні права після відновлення.
- Agent auth: enrollment ticket replay/rebinding, ClaimCredential ≠ OperationCredential, rotation lost-response,
  auth audience denial; idle/retry/heartbeat фактичні лічильники проти budgets.
- Hosted: runtime-manifest/readiness hashes, migrations/functions/scheduler/Realtime/test ingestion checks,
  identity до/після load; no production fallback.
- UI latency: browser/action/profile, warmup count, samples, visible-result proof, API time окремо,
  timeouts/censored/errors, delivery clock error bound.
- Evidence adoption: executed_pass/adopted_pass окремо; для кожного adopted case — source SHA/run,
  dependency hashes, reviewer/adoption ID; forbidden adoption дає FAIL validation, не PASS.
