# Специфікація: надійні каталоги, відеоваріації та відкладені посилання

**Feature:** `047-catalog-reliability` · **Дата:** 2026-11-05.
**Статус:** проєкт для реалізації після поточного релізу.
**Джерело вимог:** [усі інциденти та CM01–CM16](../../docs/POST_RELEASE_PROBLEMS.md).
Цей пакет є нормативним планом нового інкременту; попередні specs 031/035/039/045
продовжують діяти там, де нові вимоги їх не уточнюють. Production activation
потребує окремого release intent. Таски реалізації наразі не виконані.

## Контекст і межі доказів

Руслан двічі отримав `RESTITCH_SCREEN_FETCH_FAILED`, підтверджений native journal.
Наявна діагностика не приєднала цей terminal до `inspect`/`investigate`. Вибір
картинки зараз може повторитися; однак доказу, що обидва рази вибрано той самий
файл, немає. Причини скарг на download/share ще не доведені. «Весь сервер упав»
не є встановленою причиною. Повні ефективні налаштування перезашивки зі скриншота
не читаються, а історичного settings snapshot у наявному звіті немає.

Робота охоплює провідник, менеджер каталогів, standalone creation/settings,
Launch, manual/scheduled update та recovery. Не додає нового сховища відео,
незалежної черги або browser polling. Нові опції мають спільні контракти.

## Історії користувача

### US1 — отримати готовий каталог і зрозуміти збій (P1, MVP)

Користувач завантажує каталог або отримує URL із провідника чи менеджера;
власник продукту може пояснити результат через read-only CLI.

Незалежне приймання: A01–A06 з [плану](plan.md), реальний beta-файл відкривається,
URL доступний для ручного копіювання при забороненому clipboard; відсутній browser
event не приховує native terminal. Обмеження спостереження browser-save явні.

### US2 — завершити перезашивку попри непридатну картинку (P1)

Одне натискання автоматично пробує придатну альтернативу. Користувач бачить
причину й наступну дію, якщо жодна перевірена картинка не підходить.

Незалежне приймання: A07–A08; bad+good дає готове відео, single bad завершується
без циклу, глобальна мережева проблема не оголошує всі файли битими; cancel
зупиняє підготовку до старту обробки.

### US3 — передбачувано керувати каталогами (P1)

Одиночні та масові зміни, календар, запуск/повтор/зупинка, видалення, історія
і прогрес показують фактичний стан кожного каталогу й відновлюються після збою.

Незалежне приймання: A09–A13; втрачена відповідь після commit звіряється;
частково виконане видалення не повторює успішні дії; нова спроба не успадковує
старий відсоток; зміна простору не показує старі дані.

### US4 — підготувати N відеоваріацій (P2)

У Launch і кожному місці створення можна задати N. У менеджері є додаткова
кнопка з інпутом. Значення означає загальну кількість у наступному наборі:
1→10 означає 10, не 11. Варіації випадково розставляються по товарах.

Незалежне приймання: A14–A17; N=5 дає п'ять окремих outputs і зрозуміле K/5;
restart при 3/5 зберігає готові результати, cancel не запускає решту роботи.

### US5 — додати відеопосилання у вибрану дату й час (P2)

Галочка «Відкладене посилання», календар і час дозволяють отримати каталог із
порожніми відеополями зараз, а готові відеопосилання додати автоматично пізніше.

Незалежне приймання: A18–A24; до due відеополя порожні, після due готові URL
додаються сервером навіть із закритим браузером. Регулярний update не обходить
відкладення. Показуються затримка, залежності, перенесення та скасування.

## Функціональні вимоги

- **FR-001** Download із провідника й менеджера використовує перевірений
  bytes/export contract конкретного формату, валідні grants і правильне ім'я/MIME.
  Втрата stream або невідомий результат не є успішним збереженням.
- **FR-002** Share/get-link повертає довірений URL або конкретну машинну причину;
  permission mutation має stable intent і reconciliation після втраченої відповіді.
- **FR-003** Отриманий URL доступний у стійкому полі Copy/Open при відмові clipboard;
  повтор Copy не повторює share, pending action не дублюється подвійним натисканням.
- **FR-004** Дії розділяють intent, accepted, provider verified, browser handoff,
  copied та visible. Неспостережуваний disk-save позначається unknown, не success.
- **FR-005** API не приховує invalid rows і не перетворює malformed count/boolean
  на 0/false. Valid empty, partial, stale та unavailable мають різні стани.
- **FR-006** CLI приєднує native terminal і safe cause до відповідної операції
  навіть без browser events; неоднозначний join не вигадується.
- **FR-007** CLI audit/investigate мають bounded reads, as-of, freshness, truncation
  та явні missing/unsupported sources; timeout одного джерела не означає covered.
- **FR-008** Непридатна картинка автоматично замінюється до processing, у межах
  однієї дії, зі скінченним перебором без повтору відхиленої версії кандидата; cached і
  fresh inputs проходять достатню decode validation до прийняття screen set.
- **FR-009** File-specific failure, expired grant, changed source, загальний outage,
  права та local disk розрізняються; cap reached не називається «всі картинки биті».
- **FR-010** Retry/restart зберігає snapshot ефективних налаштувань, selected
  candidates/version, exclusions і parent/child IDs. Звичайне нове натискання спершу
  уникає unchanged known-bad candidates через обмежену пам’ять між спробами; expiry,
  source/settings version change або окрема дія revalidate дозволяють нову перевірку.
  Діагностика не видає поточні налаштування за історичні.
- **FR-011** Cancel під час draw/download припиняє нову роботу, зберігає вже відомі
  receipts і чесно показує невизначені операції та cleanup.
- **FR-012** Single/bulk save мають CAS і per-item accepted/rejected/conflict/unknown;
  readback передує повтору невизначеної mutation, confirmed items не повторюються.
- **FR-013** Bulk schedule зберігає interval/time/day/zone атомарно, має mixed/keep,
  DST validation, preview і undo, який не перезаписує чужу зміну.
- **FR-014** Масове видалення має stable keys, per-item outcomes, refresh при partial
  та повтор лише failed/unstarted після звірки unknown; referenced outputs захищені.
- **FR-015** Run/retry/stop показують фактичний accepted count/no-op; stop активної
  роботи й вимкнення регулярного розкладу є окремими діями.
- **FR-016** Прогрес прив'язаний до generation/attempt; нова спроба скидає старий
  максимум, last verified success зберігається окремо.
- **FR-017** History/readback bounded, скасовуються на виході зі scope; SSE/Realtime
  мають одного власника, без нового recurring polling; reconnect перечитує snapshot.
- **FR-018** Versioned settings і runtime facts не зливаються в хибний snapshot;
  історія зберігає partial/unknown, locks/drafts/selection належать actor/team/catalog.
- **FR-019** N — ціле загальне число 1≤N≤effective productCount; legacy default 1.
  Нуль товарів або зменшення кількості нижче N дає валідацію, без silent clamp.
- **FR-020** N означає N фізичних результатів перезашивки, а не N URL одного файла.
  Старий зміст catalog `variant` не змінюється; video variant має окрему identity.
- **FR-021** Випадковий розподіл збалансований: усі N використані, різниця частоти ≤1.
  Mapping за stable row identity зберігається; retry не перемішує його наново.
- **FR-022** N доступне у Launch, усіх creation/settings flows і менеджері;
  зміна N діє на наступну генерацію, активна використовує immutable snapshot.
- **FR-023** Durable parent/children відновлюють confirmed outputs; unknown upload
  звіряється до повтору; claims/grants bounded і lazy; часткова готовність не знижує N.
- **FR-024** UI показує ready K/N і поточний child stage, окремо готовність таблиці;
  parent cancel припиняє enqueue, а робочий каталог зберігається до verified заміни.
- **FR-025** Відкладення задається checkbox + календар + час + видима IANA zone;
  server-validated UTC instant однозначний, past time/DST gap/fold обробляються явно.
- **FR-026** Створення таблиці з порожніми відеополями може завершитися до всіх N
  відео. Ідемпотентне створення й реєстрація publication не дублюють каталог.
  Delay працює і з restitch off: тоді додається вихідне відео, без фіктивної генерації.
- **FR-027** Одноразовий серверний job додає готові посилання не раніше dueAt,
  незалежно від регулярного інтервалу та браузера; not-ready/outage дають видиму затримку.
- **FR-028** Creation, manual/scheduled writer, Launch recovery, retry і due worker
  дотримуються спільної publication policy та актуального fence/revision.
- **FR-029** Reschedule/cancel/add-now мають CAS та reconciliation applying/unknown.
  Cancel утримує порожні поля; Add now є явним наміром. Вимкнення після publication
  не видаляє чинні URL; планування заміни не приховує вже опублікований набір.
- **FR-030** Зміна/видалення каталогу або row recipe до due не дозволяє stale write;
  pending outputs утримуються від cleanup до settlement усіх consumers.
  Чинний доставлений target/mapping відокремлений від pending replacement;
  active pointer змінюється тільки після verified provider settlement.
- **FR-031** Legacy N=1/immediate працює, старий клієнт не скидає нових полів;
  old executor не claim unsupported contract і не обходить publication hold.
- **FR-032** Membership, role, entitlement, provider access, cross-team ownership,
  RLS і execution lease перевіряються на межах; auto fallback не розширює права.
- **FR-033** Кожна змінена journey має stage/flow/operation/attempt, outcomes,
  recovery та producer→ingestion→CLI acceptance за spec 031; collection bounded,
  без URL, secrets, paths, media/provider payloads. Coverage inventory оновлюється.
- **FR-034** UI використовує DESIGN.md, існуючі компоненти/токени, uk/en,
  keyboard/focus, 390 px і 200% zoom; стан не кодується лише кольором.
- **FR-035** Список перевіряється на 0/60/500/2000 рядках; зайві квадратичні lookup
  прибираються за виміром. PowerGovernor/managed spawn/cancel/timeout діють на обох ОС.
- **FR-036** Зміни мають failing regression до виправлення, isolated DB/release gates,
  exact-SHA beta acceptance та післярелізну перевірку. Production не змінюється під
  час розслідування; відсутність сигналу не доводить виправлення інциденту.

## Ключові сутності

Catalog/profile, immutable generation settings, video-set generation, indexed
video child, versioned row assignment, scoped screen rejection, publication policy/job,
execution lease, provider receipt і output reference. Деталі — [data-model.md](data-model.md).
URL і secret grants не входять до аналітичних сутностей.

## Критерії успіху та перевірка

Тести є обов'язковою частиною цієї специфікації для доведених bugs, state machines,
recovery і нових workflows; не потрібні тести, що лише дублюють розмітку чи реалізацію.

- **SC-001** A01–A06 доводять реальне отримання beta-файла/URL і точну CLI-причину;
  жоден перевірений handoff не класифікується як неспостережуваний disk-save.
- **SC-002** A07–A08: один click bad+good завершує перезашивку; всі непридатні
  кандидати/ліміт/глобальна помилка завершуються без нескінченного повтору.
- **SC-003** A09–A13: жодна confirmed mutation не дублюється після втраченої відповіді,
  кожен partial/unknown має видимий результат і recovery action.
- **SC-004** A14–A17: рівно N outputs, усі N присутні в assignment; restart на 3/5
  не перегенеровує три готові результати; cancellation працює на macOS і Windows.
- **SC-005** A18–A24: жодного раннього video-link write; due job з готовими outputs
  працює без відкритого браузера, перевірка читає фактичні поля provider.
- **SC-006** A25–A26: усі дії доступні клавіатурою/на 390 px/200% zoom;
  ціль p95 локальної реакції ≤200 мс для 500 рядків, із зафіксованим harness і hardware.
- **SC-007** Для всіх journeys FR-033 перевірені emitted→accepted→persisted→queried
  сигнали, late/missing/unsupported і privacy guards; немає critical blind spot,
  позначеного як covered без доказу.
- **SC-008** Applicable A01–A26, isolated migrations, verify/release і packaged beta
  пройдено для candidate SHA; після фактичного релізу окремо звірено інциденти за as-of.

Відсутність production повторів до релізу, відсотки без denominator і mock-only
provider success не є критеріями виконання. Матриця та винятки — [quickstart.md](quickstart.md).
