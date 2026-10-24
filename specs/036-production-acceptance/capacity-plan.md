> **Current scope decision — 2026-10-24:** 036 is CLOSED for completed local implementation and verification. Remaining substantial acceptance obligations are OPEN in [042 Production Readiness](../042-production-readiness/spec.md), with exact mapping in [scope-transfer.json](scope-transfer.json). See [closure.md](closure.md). Earlier full-campaign requirements and NO_GO checkpoints below are retained as historical requirements/evidence for 042; no production GO or test PASS is inferred from this scope change.

# Місткість на 30–50 людей і рішення щодо Supabase

**Статус: протокол та попередня оцінка, не виконаний load test.** Дата повторної перевірки джерел: 2026-10-21. Квоти повторно звірити перед продажами.

## Відомі дані та межа висновку

У [аудиті 12 жовтня](../../docs/SUPABASE_HEALTH_REPAIR.md) зафіксовано 705 244 307 байтів бази, з яких 499 605 504 — transfer grants з індексами. Це історичний вимір, не поточний стан. Там же описано розгортання reuse/retention 13 жовтня та те, що status-only виправлення вебу ще локальне. [Другий аудит](../../docs/SUPABASE_TABLE_AUDIT.md) описує обмежене очищення cron/catalog history й усунення дубльованого індексу. DELETE не означає негайне зменшення фізичного розміру.

Тому **Free поки не доведено придатним**: історичний розмір уже вищий за його квоту. Не множити історичні 705 МБ на 50 і не називати всю базу корисними даними; відділити backlog, reusable allocated pages, чинні записи, індекси та прогноз приросту. Потрібен свіжий read-only baseline після ремонту, потім тренд.

## Квоти для порівняння

| Ресурс                    | Free              | Pro                         | Приймальний бюджет Free, 70% |
| ------------------------- | ----------------- | --------------------------- | ---------------------------- |
| Database                  | 500 MB / проєкт   | 8 GB disk / проєкт включено | 350 MB                       |
| Storage                   | 1 GB              | 100 GB                      | 0.7 GB                       |
| Egress                    | 5 GB / місяць     | 250 GB / місяць             | 3.5 GB                       |
| Cached egress             | 5 GB / місяць     | 250 GB / місяць             | 3.5 GB                       |
| Realtime messages         | 2 млн / місяць    | 5 млн / місяць              | 1.4 млн                      |
| Realtime peak connections | 200               | 500                         | 140                          |
| Edge invocations          | 500 тис. / місяць | 2 млн / місяць              | 350 тис.                     |
| MAU                       | 50 тис.           | 100 тис.                    | 35 тис.                      |

Pro від $25/місяць; $10 compute credits покривають один Micro. Автоматичні DB backups: Free — не включені, Pro — 7 днів. Free може призупинятися після тижня неактивності. Квоти беруться з [офіційної таблиці тарифів](https://supabase.com/pricing). Egress і cached egress рахувати окремо, не як один взаємозамінний бюджет. Обсяг квот organization/project і їх використання іншими проєктами перевірити за [billing](https://supabase.com/docs/guides/platform/billing-on-supabase).

Окрема межа Realtime throughput: Free 100 messages/s, Pro 500 messages/s; джерело — [Realtime limits](https://supabase.com/docs/guides/realtime/limits). Наш 70% поріг Free — 70/s. Браузерний Realtime socket не дорівнює прямому Postgres connection. Показники CPU/RAM/IO/connection pool вимірюються незалежно; місячна квота повідомлень не доводить достатню продуктивність.

## Профілі даних та активності

Це **тестові припущення**, які коригуються під фактичний перший продаж із збереженням гіршого сценарію.

- 30 людей: 6 команд по 5. 50 людей: 10 команд по 5. Додатково одна команда на 50 для максимального fan-out і 50 одноосібних просторів для вартості background jobs.
- На команду: 5 000 індексованих матеріалів, 100 папок, 200 завдань, 20 рекламних акаунтів, 30 днів фінансів, 10 каталогів; для стресу — 20 000 матеріалів на команду. Для 50 одноосібних просторів спершу тримати такий самий загальний обсяг, потім окремо перевірити збільшення загального обсягу.
- На активну людину за годину: 30 відкриттів/пошуків/переходів, 6 змін завдань/метаданих, 2 операції з файлами. На команду за годину: 2 ручні sync, 20 зовнішніх змін Drive, 1 generation/process; updater — за реальними збереженими інтервалами. Вказати розподіл розмірів файлів, кількість preview/download і cache hit ratio.
- Базово 1 активна + 1 фонова вкладка на особу; окремий пік 3 вкладки на 50 людей. При одному socket/вкладку це вже 150 sockets до службових підключень — вище нашого бюджету 140, хоча нижче ліміту 200. Фактичне число socket виміряти, не виводити з кількості людей.
- Відео, що йде напряму Drive↔agent, не зараховувати автоматично в Supabase egress. Класифікувати кожен мережевий шлях: DB/REST, Realtime, Functions, Storage, Drive, локальний агент, web hosting.

## Сценарії навантаження

| ID      | Профіль                                          | Час                          | Що довести                                                        |
| ------- | ------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------- |
| LOAD-01 | Три реальні браузерні сесії, idle → звичайні дії | 30 + 30 хв                   | Вартість простою, число підписок, ресурсна ціна однієї дії        |
| LOAD-02 | 30 осіб / 6 команд                               | 15 хв ramp + 60 хв плато     | Пороги latency/error, повнота синхронізації                       |
| LOAD-03 | 50 осіб / 10 команд                              | 15 хв ramp + 60 хв плато     | Нормальний прогноз першого продажу                                |
| LOAD-04 | 50 осіб в одній команді                          | 60 хв                        | Realtime fan-out, contention, останнє місце, масове оновлення     |
| LOAD-05 | 50 окремих просторів                             | 60 хв                        | Вартість per-team scheduler і фонової роботи                      |
| LOAD-06 | 50 осіб, 2 вкладки, змішана робота               | 8 годин                      | Витоки пам’яті, приріст таблиць, backlog, стабільність            |
| LOAD-07 | Пік 150 вкладок; одночасний reconnect            | 10 хв burst + 20 хв recovery | Ліміти connections/messages, backoff, відсутність thundering herd |
| LOAD-08 | Пауза тарифу/видалення під час піку              | 30 хв                        | Права не залежать від навантаження; фон справді зупинено          |
| LOAD-09 | Великий індекс + cleanup + updater               | 60 хв                        | IO/locks, bounded batches, відсутність starvation                 |
| LOAD-10 | Відновлення після зупинки тестового backend      | 30 хв recovery               | Немає втрат/дублів, черга повертається до baseline                |

Реальні браузери перевіряють семантику. Для 30/50 потрібен повторюваний генератор реальних авторизованих клієнтських дій, включно з підписками й отриманням результатів, а не лише прямі запити до таблиць. Підготовка такого harness — завдання наступного плану. Автоматичний генератор не замінює ручні кейси.

Локальна beta показує функціональність і відносні витрати, **не** реальні ліміти hosted Free. Навантаження на окремий hosted стенд потребує окремої ізольованої конфігурації: чинний beta runner забороняє remote target, не обходити цей захист. Не створювати/оплачувати стенд автоматично в межах написання спеки. Без hosted-вимірів відповідні висновки мають статус «не доведено»; production не використовувати як навантажувальний стенд.

## Збір показників

На baseline, кожному плато, burst і після recovery: UTC, тривалість, кандидат, кількість людей/команд/вкладок/socket, виконані та невдалі дії; p50/p95/p99 кінцевого користувацького часу, server response time, sync queue lag, час доставки іншому учаснику, retry/dedup, 429/5xx, connection drops.

Сервер: CPU, RAM, IO/IO budget, DB connections/pool wait, locks/slow queries, database/index sizes, grants created/reused/expired/deleted, cron/catalog history, analytics volume, Realtime messages/s й peak sockets, Functions invocations/duration/errors, Storage та egress за категоріями. Агент CPU/RAM/threads і Mac load відділяти від сервера; локальне кодування не є Supabase CPU.

Джерела — існуючий read-only CLI та дозволені офіційні read-only usage/metrics інтерфейси. Для неохопленого показника додати безпечне розширення CLI в план реалізації, не ручний SQL. `database-retention` дає легкі cumulative counters; дельта = end−start тільки якщо не було stats reset. Повні aggregate scans — на початку/кінці, не щохвилини. Детальна частота метрик hosted має бути обмеженою, наприклад 60 с, і врахованою в накладних витратах. Невідомі gauges залишити unknown.

Production після запуску: обмежені read-only знімки щодня перші 14 днів та після хвиль онбордингу 10/30/50 людей, тижневий прогноз далі. Це вимога майбутнього моніторингу; розклади цим документом не створено.

## Прогноз і stop thresholds

Для кожного monthly ресурсу: `30 × (типові активні години/добу × виміряна витрата/годину + idle-витрата решти доби) + разове онбординг-навантаження + інші проєкти`. Для 90 днів показати три billing cycles та зміну стану, не порівнювати суму трьох місяців з одною місячною квотою.

Для DB/Storage: `поточний allocated/used розмір + чистий приріст до горизонту + backlog + індекси/службові накладні витрати`. Окремо моделювати retention steady state й фізичний allocated розмір; не віднімати deleted bytes як гарантовано звільнені. Realtime — сумарна фактична доставка з fan-out, не просто кількість змін. Показати низький/типовий/піковий сценарії та всі припущення.

На Free для 50 людей бюджет 1.4 млн повідомлень дає приблизно 933 повідомлення/людину/день за 30 днів; 3.5 GB egress — приблизно 70 MB/людину/місяць. Це арифметичні орієнтири для всього спільного бюджету, не персональні квоти й не доведене споживання.

- Warning: будь-яка квота/прогноз >70%, стійкий CPU >70% протягом 15 хв, зростання backlog на незмінному потоці або дві порушені p95 вибірки.
- Stop збільшення тестового навантаження: ресурс ≥85%, неочікувані помилки >1% за 5 хв, незворотна втрата/чужий доступ, падіння Auth/REST, неконтрольований retry storm. Зупинити генератор, зберегти докази; не маскувати збій очищенням даних.
- Відновлення: після burst черги та latency повертаються до baseline за ≤10 хв; немає осиротілої роботи без terminal/відомої recovery.
- До продажів підтвердити мінімальний backup RPO 24 год / RTO 4 год: [Free потребує власних exports](https://supabase.com/docs/guides/platform/backups). DB backup не замінює копії Storage objects чи зовнішнього Drive; для кожного власника даних визначити відновлення й перевірити його.

## Рішення щодо плану

1. **Залишити Free** можна лише за доведених SC, прогнозу ≤70% усіх квот, стабільного росту після retention, перевірених backups/restore та прийнятого обмеження доступності. 50 MAU самі по собі не проблема; DB/egress/fan-out можуть бути проблемою вже при малому числі людей.
2. **Pro + Micro — перший кандидат для платного запуску**, якщо Free не вкладається в розмір/трафік/надійність. Аргументи: 8 GB замість 500 MB, більші transfer/realtime budgets, автоматичні DB backups, відсутність паузи за неактивність. Це обґрунтований напрям, **не гарантія**, що Micro витримає конкретне навантаження: повторити LOAD-03/04/06/07 на ньому.
3. Якщо Pro Micro впирається в CPU/IO/пам’ять, спершу знайти зайві запити/fan-out/дублікати jobs і виміряти після виправлень; потім вибрати найменший compute add-on, який проходить ті самі пороги. Team не випливає з 50 користувачів — його потреба повинна мати окрему причину.
4. Кошторис: subscription + compute понад credits + додаткові проєкти + overages + backups/add-ons + податки. [Spend cap](https://supabase.com/docs/guides/platform/cost-control) не трактувати як універсальну межу всіх можливих витрат; окремо перевірити його застосовність до кожної статті.

Фінальна таблиця рішення: ресурс / вимір / джерело і час / прогноз 30–90 днів / квота / запас / статус / оптимізація / найменший план, що пройшов повторний тест. Якщо вимірів немає — рішення про достатність не підписувати.

## Уточнення після аналізу — 2026-10-14

До hosted LOAD потрібні candidate deployment, migrations/functions/Realtime/scheduler readiness і test ingestion
за contracts/acceptance-tooling.md, а не лише provisioned users. Runtime digest звіряється до/після прогону.
SC-003 p95 вимірюється native Safari/Chrome browser probes під тим самим load: від реальної дії до видимого
актуального результату, ≥100 спроб на action/browser/profile після 10 warmup, timeouts не відкидаються.
API time та UI time — окремі стовпці; protocol harness сам не доводить UI швидкість.

Додати в модель фоновий бюджет contracts/recovery.md: 2 idle claims/хв на delegation, installation cap 12/хв,
pause probes ≤1/60 с на delegation з installation cap 6/хв, active heartbeat 1/30 с на operation,
rotation ≤1/4 хв, до 5 transient retries/episode та до 3 automatic episodes/item/год. Врахувати реальну
кількість installations/delegations, long-poll duration/cost та server dispatch окремо; не рахувати idle=0.
Після змін agent/protocol/capture повторити affected load на кінцевому SHA; capacity доказ не переноситься
через EvidenceAdoption. Надто коротке вікно або невідома метрика не доводять достатність Free.

## Повторна перевірка офіційних квот — 2026-10-21

Це довідкові тарифи, не виміряна місткість Soty і не дозвіл на покупку. Фактичні plan,
compute, spend cap та project limits hosted acceptance-стенду ще не підтверджені.

| Ресурс за billing cycle            | Free           | Pro                                      |
| ---------------------------------- | -------------- | ---------------------------------------- |
| План                               | $0             | від $25/місяць                           |
| Auth MAU                           | 50 000         | 100 000; далі $0.00325/MAU               |
| Database                           | 500 MB/project | 8 GB disk/project; далі $0.125/GB        |
| File Storage                       | 1 GB           | 100 GB; далі $0.0213/GB/місяць, GB-hours |
| Uncached egress                    | 5 GB           | 250 GB; далі $0.09/GB                    |
| Cached egress                      | 5 GB           | 250 GB; далі $0.03/GB                    |
| Edge Function invocations          | 500 000        | 2 млн; далі $2 за пакет 1 млн            |
| Realtime messages                  | 2 млн          | 5 млн; далі $2.50 за пакет 1 млн         |
| Included peak Realtime connections | 200            | 500; далі $10/1000                       |

Джерела: [Pricing](https://supabase.com/pricing),
[Storage accounting](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size),
[Functions accounting](https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations),
[Billing overview](https://supabase.com/docs/guides/platform/billing-on-supabase).
Invocations рахуються незалежно від response status; OPTIONS не тарифікуються.

Micro: $0.01344/годину (приблизно $10/місяць), shared CPU, 1 GB RAM, 60 DB connections,
200 pooler clients, рекомендований maximum DB size 10 GB. Paid organization має $10 monthly
compute credits для одного Micro; додатковий project додає compute cost. Це не доказ, що
Micro витримає Soty. [Compute billing](https://supabase.com/docs/guides/platform/manage-your-usage/compute),
[Compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk).

Runtime Realtime limits відрізняються від included billing quota: Free 200 connections / 100
messages та joins за секунду; Pro зі spend cap 500 / 500; Pro без spend cap 10 000 / 2500.
Channels/connection — 100. Ліміти configurable, тож actual configuration треба записати окремо.
Postgres change рахується для кожного listening client; Broadcast — send плюс кожний recipient.
[Runtime limits](https://supabase.com/docs/guides/realtime/limits),
[Message accounting](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages),
[Peak accounting](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-peak-connections).

Functions runtime: 256 MB RAM, 2 s CPU/request, wall clock Free 150 s / paid 400 s,
request idle timeout 150 s. [Functions limits](https://supabase.com/docs/guides/functions/limits).

Невідомі: hosted configuration, інше споживання organization, RLS/query cost, фізичні індекси,
fan-out, байти egress, retry amplification та background/idle cost. Локальна свіжа БД близько
25 MB містить лише синтетичні fixtures і не замінює production baseline чи 30/90-day forecast.
MAU, pooler clients, Realtime connections та активні люди мають різні знаменники.
**Resource verdict залишається UNPROVEN; hosted LOAD-02–10 не виконані.**


## Локальна protocol calibration2026-10-21

Steady1 write/s:110 offered,10 warmup,100/100 correct writes;300/300 measured receiver deliveries,
p95≈592ms. Burst5/s:15/100 actions dropped через concurrency bound4,255/300 deliveries.
5 independent Auth clients/channels, три authorized receivers; X/S не одержали жодного сигналу;
teardown перевірений. Steady мав440 signals на кожний authorized client за110 creates: це1320
observed received messages на три receivers, не110. Actual hosted billable total та інші channels
не вимірювалися. Обидва прогони мали concurrent verification на Mac; це не clean baseline,
не native DOM latency і не доказ50-user capacity/Free quotas. Історія обох profiles збережена в
`release/acceptance/acceptance-036-realtime-20261021/`.

Billing fan-out потрібно рахувати за кожним listening client, а не за однією user action;
peak connections сумуються за per-project peaks. Джерела повторно перевірено21 жовтня:
[message accounting](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages),
[connection accounting](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-peak-connections).
DB backup не повертає Storage object bytes, тому full restore proof досі потребує окремої
Storage/Drive копії; [official backup limits](https://supabase.com/docs/guides/platform/backups).
