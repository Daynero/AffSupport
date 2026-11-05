# Validation guide — 047

Це сценарії майбутньої реалізації. Вони не були виконані під час планування.
Починати після завершення поточного релізу з isolated checkout за T001.
Повна матриця A01–A26 — [plan.md](plan.md); stage/error/time semantics —
[contract](contracts/catalog-lifecycle.md). Фіксувати exact SHA, OS, capabilities,
команду, outcome, доказ і обмеження; user media/URLs/grants у звіт не записувати.

## Підготовка

1. Звірити baseline, active contract і застосовану schema без production writes.
2. Read [BETA.md](../../docs/BETA.md), запустити `npm run beta:doctor`.
   Не зупиняти чужий active build/agent. Beta auth/entitlements реальні;
   `VITE_LOCAL_DEV_AUTH` заборонений. Production telemetry вимкнена.
3. Ізольовані authorized provider fixtures: catalog із п'ятьма товарами, source
   video, good/bad/corrupt-cache/truncated image, окремі restricted/revoked файли.
   Перед security tests перевірити tenant separation, не використовувати чужі дані.
4. Спочатку failing regression на конкретний bug; потім fix і single-worker touched
   test. Назви майбутніх файлів у tasks позначають заплановані outputs.

## Runnable checks

Наявний короткий baseline (не доказ нових lifecycle):

```bash
nice -n 15 npx vitest run tests/catalog-updater-dialog.test.tsx tests/catalog-bulk-editor.test.tsx tests/catalog-inline-changes.test.tsx tests/catalog-row-progress.test.tsx tests/catalog-ui-diagnosis.test.ts tests/material-action-surfaces.test.ts tests/team-restitch-screens.test.ts tests/catalog-profile-outcome-api.test.ts --maxWorkers=1 --minWorkers=1
```

Перед candidate commit, послідовно за AGENTS.md:

```bash
nice -n 15 npm run verify
nice -n 15 npm run verify:release
```

`test:db` — тільки штатний isolated runner із schema/roles локальної Supabase;
не remote URL. Зберегти `verification-result.json` для кожного етапу перед наступним
запуском. Packaged beta proof — через канонічний BETA runbook для candidate SHA,
без production release. Нема тестів, що silently pass при відсутньому binary.

## Story acceptance

| Story | Дії                                                                                 | Очікуваний доказ                                                                      |
| ----- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| US1   | Download/share із двох поверхонь; denied clipboard; network/403/malformed payload   | Файл відкривається, URL selectable; правильний failure і delivery boundary; A01–A06   |
| US2   | Bad+good, одна bad, all bad, cached corrupt, глобальний outage; cancel              | Один click дає fallback або кінцевий точний outcome; bounded calls, без loop; A07–A08 |
| US3   | Lost save reply; mixed bulk schedule; partial trash; count=0/cancel=false; two tabs | Readback/per-item outcomes, no blind replay, current attempt progress; A09–A13        |
| US4   | N=1/5/P; 1→10→1; restart на 3/5; cancel download/process/upload                     | N physical receipts і balanced mapping; outputs не дублюються; A14–A17                |
| US5   | Calendar+time, N=5; routine update before due; close browser; due publication       | Empty до due, actual mapped cells після; no stale/early write; A18–A24                |

Для US5 окремо: DST gap/fold, source/output revoked, entitlement expired, agent
offline до/після підготовки, concurrent external provider edit, cancel/reschedule
при dispatched write, deleted catalog, old agent за new server, provider unknown, held→rescheduled.
Обов’язково restitch off + delay: original link без fake video set; published
N=1→pending N=10: старий target/assignment зберігається до verified нової публікації.
Readback перевіряє actual cells/recipe, не metadata marker. Недоведена provider CAS
блокує shipping writer; unconditional overwrite не є допустимим fallback.

## Діагностика: окрема ізольована доріжка

T014 створює `tests/catalog-diagnostics-ingestion.test.ts` і fixture-runner через
існуючі ingestion/CLI seams. Synthetic producer payload проходить справжні guards,
sanitizer, ingestion і stored query; CLI під SELECT-only роллю, loopback disposable DB.
Fixture outputs містять opaque IDs і safe config, без контенту або provider URL.

Після появи тесту запускати:

```bash
nice -n 15 npx vitest run tests/catalog-diagnostics-ingestion.test.ts --maxWorkers=1 --minWorkers=1
```

Перевірити success/failure/partial/cancel/missing browser terminal/native-only
terminal/late duplicate/conflicting signal/unsupported producer/source timeout.
Одна emission не дорівнює coverage. У звіті synthetic acceptance не називається
production evidence. Real beta UX/provider acceptance зберігається окремо.

## Приймання пакета, швидкодії та післярелізний ефект

### Ранній package acceptance

US1 може мати окремий candidate після T014: applicable A01–A06, його regressions,
повні canonical verify/build/release gates для exact source scope, ізольована
diagnostic acceptance та належний exact-SHA beta proof. US1–US3 пакет додає
A07–A13. Не включати незавершений N/delay contract у ранній пакет; isolated checkout
має містити тільки його завершений source scope. Відсутність міграцій/agent змін
визначається фактичним diff і штатними gates, не назвою пакета.
Окремий `reviews/package-us1.md` / `reviews/package-core.md` зберігає доказ;
T056–T059 у full checklist лишаються відкритими до повного scope. Production
activation все одно окремо авторизується. Subset не є позначкою виконання full tasks.

### Відтворюване вимірювання A26

T053 створює `tests/catalog-manager-performance.test.tsx` для детермінованих
render/read-count guards і browser fixture harness у
`specs/047-catalog-reliability/reviews/performance.md`. UI latency вимірює реальний
browser, не jsdom. Для baseline/after однаковий production-mode beta web bundle
на тій самій машині; записати SHA, OS, CPU/RAM, browser/version, viewport 1440×900,
power 100%, без CPU/network throttling. Реальні user rows не використовуються.

Fixtures 0/60/500/2000 мають deterministic seed, mixed success/running/error/held,
повні profiles, довгі й дубльовані українські назви. Після initial authoritative
load заморозити transport на fixture; network час рахувати окремо. На кожному
size після 10 warmups виконати по 50 samples: search/filter (половина matches),
toggle selection і open/close details за stable ID. Boundary — input handler start
до наступного paint із потрібним DOM state (browser trace або verified frame).
Зберегти raw samples, p50/p95, renders і read requests для кожної дії; для 500
кожен із трьох p95 ≤200 ms. 2000 — stress без crash/нескінченних reads, цифри
звітуються без вигаданого такого самого SLA. Cold initial-load 10 samples окремо.
На другій ОС — functional/stress parity; якщо hardware інший, latency порівнюється
лише з його власним baseline. Пагінація/virtualization не ламає повний пошук і selection.

### Production effect

T060 використовує documented CLI `investigate`, `inspect`, `catalog`, `journal`,
`audit` з фактичним released cohort і fixed as-of. Runtime IDs беруться з контрольної
спроби, історичні incidents — з backlog. Порівняти attempts denominator, freshness,
delivery lag і missing sources; окремо підтвердити, що користувач отримав файл/URL.
Старі незібрані налаштування не відновлюються заднім числом через нові signals.
Відсутність повторної скарги або events не закриває incident без потрібних доказів.
