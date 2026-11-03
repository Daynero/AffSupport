# План усунення лагів Простору

Дата: 3 листопада 2026. Статус: кодові виправлення реалізовані локально;
повний fast verify і додаткові build/database/browser перевірки пройдені. Production і тариф сервера не змінені. Результати та межі
перевірок: [validation](WORKSPACE_PERFORMANCE_VALIDATION.md).
Підстава: [розслідування інциденту](INCIDENT_WORKSPACE_LAG_2026-11-03.md) та
повторний незалежний огляд frontend, server/capacity і діагностики трьома агентами.

## Межі роботи

- Не залучати реальних користувачів до перевірок, не просити повторних імпортів,
  перепідключень Drive або тестових генерацій.
- Перевірки до релізу: автоматизовані тести, синтетичні акаунти, локальні fixtures
  та ізольована beta. Після релізу — пасивне спостереження за звичайною роботою.
- Не змінювати production у межах планування. Не збільшувати вартість інстансу,
  connection/worker limits чи concurrency навмання.
- Зберегти прогресивну роботу з уже доступними файлами під час індексування.
  Блокування всіх каталогів до завершення scan не є прийнятим виправленням.
- Не послаблювати RLS, session/access checks, privacy guard, fences, receipts,
  захист від дублювання generation та відновлення після втрати відповіді.

## Що підтверджено і що ще невідомо

Підтверджено зайвий request fan-out: 10 catalog-only сигналів спричиняють
10 зайвих task reads та 10 team-list reads в одному клієнті. Також знайдені
polling у прихованих вкладках, відкидання застарілих відповідей без припинення
самих запитів, і explorer timeout через Promise.race без справжнього abort.

Під час інциденту сервер повертав statement timeouts, HTTP 500/504 та cron
startup timeouts. RAM близько 929 MiB, shared_buffers 256 MiB; зайнятий swap
після інциденту — ознака обмежених ресурсів, але не доказ першопричини.
Cron працює через з'єднання, а не background worker slots. Тому підняття
max_worker_processes не є виправленням цього startup timeout.

Не доведено: що каталоги до завершення scan запустили інцидент; що достатньо
додати RAM; що є auth-lock deadlock; що history cleaner був первинним тригером.
Поточний SDK не можна діагностувати за припущеннями про старі версії auth-js.

Окремий ризик повторного огляду: task cache є module Map без actor/access epoch
у ключі. Це потребує регресійного відтворення на зміні акаунта; фактичний витік
між користувачами ще не доведений. Через вплив на приватність перевіряється першим.

## Порядок реалізації

### 0. Зняти baseline та повернути повну діагностику

Файли: `scripts/analytics/commercial-access.ts`, `investigate.ts`, `types.ts`,
`queries.ts`, `database-health.ts`, відповідні `tests/analytics-*`.

1. Виправити статичні тексти, які відхиляє privacy guard: слово OAuth в описі
   commercial projection та slash у tariff/member. Не розширювати дозволи guard.
2. Додати інтеграційний fixture повного investigate з усіма встановленими
   projections і записом needs_review; зберегти негативні privacy tests.
3. Для guard failure повертати безпечну категорію/схемне поле, без значення.
4. Явно розрізняти occurred_at і created_at доставки. Для causal timeline
   позначати window_basis; не міняти мовчки семантику всіх існуючих команд.
5. Зафіксувати counters і read-only snapshots: RPC за доменами, тривалість,
   queue age, активні reads, retries, generation/sync attempts, SQL/cron errors,
   CPU modes, available RAM, swap-in/out, IO, connections і blockers.
6. Врахувати кешування provider metrics: незмінні CPU counters між HTTP
   відповідями не є доказом нульового навантаження. Рахувати дельти лише між
   свіжими різними samples. Не трактувати відсутню метрику як нуль.

Готовність: investigate працює без приватних значень; delayed events не
потрапляють у причинний висновок як нові дії; baseline відтворюваний.

### 1. Перевірити й закрити ізоляцію кешів

Файли: `team/tasks/useTasks.ts`, identity lifecycle, наявні account/finance stores.

1. Відтворити sign-out → інший sign-in без reload; downgrade/revoke membership;
   перемикання команди під час повільного читання.
2. У ключі та lifetime кешів врахувати actor, project, team, access epoch і всі
   параметри scope: filters, sort, pagination, timezone де вона впливає на дані.
3. Очистити/інвалідувати приватний кеш на sign-out, зміні actor, втраті доступу.
   Обмежити його розмір та час зберігання; жодного показу старих рядків до RLS read.
4. Зберегти account writesBefore fence, optimistic edits, finance drafts та
   authoritative mutation receipts. Не замінювати їх одним універсальним кешем.

Готовність: ні стара відповідь, ні кеш не можуть повернути дані іншого scope;
власне підтверджене редагування не затирається запізнілим read.

### 2. Розділити інвалідації за доменами

Файли: `team/TeamContext.tsx`, `useTeamRealtime.ts`, споживачі revision.

1. Запровадити типізовані причини invalidation: catalog/explorer, storage,
   tasks, accounts/finance, catalog-updater, membership/access.
2. Catalog/storage events не повинні перезапускати task/member/team-list reads.
   Account/finance refresh — лише за відповідними змінами, не кожним файлом.
3. listTeams — для membership/team/access change, початкового входу та
   authoritative reconnect catch-up. Явна загальна invalidation лишається для
   операцій, що дійсно зачіпають кілька доменів.
4. Membership revoke/downgrade обробляти терміново навіть у hidden tab:
   перестати показувати захищені дані й перевірити актуальний доступ.
5. Зберегти каталогову freshness, subscribe race, reconnect catch-up,
   обробку події, що прийшла під час читання, та захист від старих відповідей.

Готовність: 10 catalog-only ticks після initial load дають нуль додаткових
task/member/team-list/finance reads, але потрібні catalog reads відбуваються.

### 3. Обмежити in-flight reads, retries та опитування

Файли: `tasks/useTasks.ts`, `TaskSpace.tsx`, `members/MemberList.tsx`,
`storage/useStorageHealth.ts`, `catalog-updater/useCatalogUpdater.ts`,
`explorer/useFolderPage.ts`, `useCatalogSearch.ts`, `workspace/WorkspaceShell.tsx`,
accounts readers і API seams.

1. Для одного повного ключа читання: максимум один активний read; нові сигнали
   зводити в dirty flag і одне наступне актуальне читання. Подія під час цього
   follow-up має знову позначати dirty — не втрачати останню зміну.
2. За зміни scope/unmount реально передавати AbortSignal до HTTP/RPC, де це
   підтримується. Fencing залишити: abort не доводить зупинку сервера.
3. Explorer: прибрати накладання кількох refreshWindow поверх обходів до трьох
   повторів усіх сторінок. Один власник обходу, bounded retry/backoff, реальний
   abort. Зберегти loaded window, loadMore, preserveOnEmpty, strict reload і
   актуалізацію після мутацій; cancellation не перетворювати на INVALID_RESPONSE.
4. Search: відокремити словник/фільтри від результатів, не читати обидва через
   кожну нерелевантну revision; інвалідувати за справжньою залежністю.
5. Прихована вкладка: призупинити звичайні pollers, зберігати dirty state;
   повернення — один актуальний refresh на домен. Не вимикати security events.
6. Прибрати дубль health/explorer polling між shell і hooks. Poll лише для
   актуального розділу/видимого status, із bounded backoff на помилках.
7. Finance вже має coalescing: перевикористати його, зменшити зайві джерела
   refresh, не переписувати чернетки/period cache без потреби.

Готовність: повільний read + 100 сигналів не створює 100 запитів; після
стабілізації є одне актуальне відображення. При hidden tab звичайні polls стоять.

### 4. Перевірити auth та catalog generation поруч із sync

Файли: `auth/AuthContext.tsx`, `profile-invalidation.ts`, `lib/supabase.ts`,
`CreateProductCatalogDialog.tsx`, `supabase/functions/drive-ops/product-catalog.ts`.

1. Виміряти окремо auth readiness, HTTP, response parsing та UI delivery.
   Перевірити реальний встановлений SDK із затриманим refresh і burst 401.
2. Прибрати дубльований focus/visible refresh для тієї самої активації, але
   не пропускати sibling update або наступний актуальний read після зміни профілю.
3. За потреби додати shared refresh promise з actor/session fence. Не
   збільшувати timeout і не вимикати auth refresh як спосіб приховати симптом.
4. Generation не повинна чекати весь Drive. Перевіряти конкретні залежності:
   відео, актуальний credential, permissions, pools/settings і їхню версію.
5. Якщо конкретна залежність неготова — явний bounded queued/not-ready стан із
   кодом і зрозумілим recovery. Повтор не створює другий Sheet/каталог і не
   повторює вже підтверджений side effect.
6. Додати agent-readable generation receipts: intent/operation/attempt,
   acceptance/terminal, safe dependency readiness і sync stage. Без назв,
   контенту, raw paths, credential або Google payload.

Готовність: slow auth не створює штормів; generation під час scan працює з
готовими залежностями або чесно очікує, без дублів після retry/lost reply.

### 5. Сервер і cron — тільки зміни, обґрунтовані вимірами

1. Зберегти наявні sync bounds: до трьох leased jobs глобально, один job на
   worker invocation, bounded transcript concurrency. Не додавати workers.
2. Виміряти actual concurrent cron connections, а не робити висновок із ceiling 32.
   Cron admission, initial sync і catalog generation мають різні бюджети.
3. Для cleaner перевірити план на fixture з обсягом історії production, пустий
   backlog та невеликий backlog. Довести причину scan/sort/IO перед зміною SQL.
4. Якщо потрібне зменшення concurrency або рознесення schedules — перевірити
   fairness, queue age, retries і starvation у beta; не вимикати cleanup/recovery.
5. Не збільшувати max_connections: більша кількість backend може збільшити RAM.
   Не чіпати max_worker_processes як лікування cron при background_workers=off.
6. SQL/index changes — лише після плану/вимірів, окремою міграцією зі штатними
   beta/release gates. Ніякого ручного DDL на production.

## Перевірки без користувачів

### Автоматизовані регресії

- Матриця domain event → дозволені reads; urgent membership/access винятки.
- Slow response,100signals, lost reply, timeout, abort до fetch і після fetch.
- Hidden/visible, reconnect, дві вкладки, зміна actor/team/прав/фільтрів.
- Account edit під час старого read, finance drafts і зміна period.
- Explorer із кількома сторінками, filter change/loadMore/retry/empty result.
- Справжній installed auth client зі штучно затриманим transport.
- Generation під час partial index, відсутні pools/credential, подвійний retry,
  припинення/recovery, відмова в доступі та міжкомандна ізоляція.
- Повний privacy-safe investigate, delayed delivery і pinned as-of semantics.

### Синтетичний сценарій в ізоляції

1. Три окремі браузерні сесії тестових акаунтів; окремі команди та спільна
   команда. Набори 10, 400 і кілька тисяч згенерованих файлів/метаданих.
2. Початковий sync + tasks/members/search + creation catalog у дозволений момент.
   Порівняти trace до/після; рахувати реальні RPC, не лише mocked onRefetch.
3. Повільний network/auth,500/504,100 сигналів, кілька вкладок, hidden foreground.
4. Повторити для10 сесій для запасу; тривалий synthetic soak за вимогами
   приймальної кампанії. Це не запрошення10 реальних людей.
5. Обмежити локальні ресурси й кількість важких процесів; не проводити stress
   на production. Локальний quota не відтворює shared cloud CPU/credits, це
   обмеження записати у висновку, а не оголосити capacity proven.

Критерії за існуючою acceptance specification: після прогріву p95 від дії до
правильного видимого списку/пошуку ≤2 с; ≥99% звичайних дій успішні; зміна в іншій
активній сесії ≤5 с, foreground/reconnect catch-up ≤15 с. Окремо нуль втрат,
дублів і міжкомандних витоків. Очікувані negative cases не рахувати як збої.

Додаткові критерії цього виправлення: один in-flight read на ключ; bounded
follow-up; нуль сторонніх reads від catalog-only tick; відсутні startup та
statement timeouts у контрольованому сценарії; записані connection/CPU/RAM/IO
та queue-age counters. Наявні scale tests, що мокають callback цілком, не є
доказом виконання цих критеріїв.

## Рішення про серверний тариф

Додаткова пасивна перевірка 3 листопада, приблизно 17:09–17:13 Київ:
між двома свіжими наборами cumulative counters non-idle CPU становив близько
13.5% (включно з IO wait/steal), доступна RAM змінилася зі 171 до 305 MiB.
Swap-in зріс на 19 075 сторінок, swap-out — на 13 376. Тобто активність swap була,
але ці виміри не доводять її впливу на минулий інцидент або потреби в конкретному
новому інстансі. Проміжний HTTP sample був повністю кешованим; його відкинуто
для розрахунку дельт. Часових samples самого піку інциденту немає.

На цьому етапі дорожчий тариф **не обґрунтований як необхідна перша дія**.
Спочатку усуваємо підтверджену зайву роботу. Водночас гарантувати, що поточного
інстансу вистачить після виправлення, без виміряного workload не можна.

Рішення залишити чинний тариф приймається за результатами виправленого
синтетичного workload, resource headroom і наступного пасивного спостереження.
Ціль — не менше 30% headroom за релевантними ресурсами, стабільні queue age і
latency, без sustained swap-in/out та admission timeouts. Для cumulative
counters використовувати дельти свіжих samples, а не абсолютні значення.

Апгрейд розглядається лише якщо після усунення fan-out і перевірених concurrency
bounds помилки/latency лишаються та збігаються з виміряним sustained CPU/RAM/IO
дефіцитом. У такому разі підготувати окремо: конкретний exhausted resource,
поточний і потрібний запас, варіанти інстансів, актуальну ціну та очікуваний
ефект. Зміни billing/інстансу цей план не виконує.

## Реліз і пасивний контроль

1. Focused regressions → `npm run verify` повністю → release checks потрібної
   форми → exact-commit packaged-beta verification за штатним runbook.
   Перевірки виконують агенти/автоматизація на synthetic fixtures, не користувачі.
2. Якщо diff містить лише допустимі web зміни — перевірити eligibility web-mini.
   DB/functions/shared/agent зміни не маскувати під web-only. Вибрати реальний
   release path за фінальним diff та `docs/PRODUCTION.md`.
3. Production — окрема активація після готового перевіреного результату; не
   пропускати існуючі gates через відмову від user pilot. Цей документ не є deploy.
4. Після релізу спостерігати звичайну роботу через read-only CLI: початкові
   15–30 хв,1–2 год та наступну добу. Не запускати для цього імпорти/генерації
   або перепідключення на користувацьких акаунтах.
5. Порівнювати task/member/profile latency, domain RPC rate, error 500/504,
   startup/statement timeouts, queue age, sync/generation terminal coverage,
   available RAM, CPU modes, swap/IO та connections. Невідоме лишається невідомим.
6. Поріг розбору/зупинки подальшої активації: >1% неочікуваних помилок за 5 хв,
   sustained resource ≥85%, зростаюча черга або будь-яка втрата/дубль/витік.
   За інциденту зберегти evidence й діяти за runbook; без автоматичного rollback,
   replay невідомих операцій, reset черг чи restart production навмання.

## Групування змін для рев’ю

1. Діагностика/privacy та cache isolation regressions.
2. Domain invalidations і security/catch-up semantics.
3. In-flight coordination, explorer retry/cancel і visibility-aware polling.
4. Auth/generation dependency diagnostics та synthetic mixed-load acceptance.
5. Лише за доказами — backend/SQL/concurrency repair.
6. Exact-commit beta proof, штатний реліз, passive production comparison.

Для кожного кроку: scope, регресія до виправлення, результат після, diagnostic
coverage і залишкові обмеження. Готовність плану не означає готовність коду.
