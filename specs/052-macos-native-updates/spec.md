# Feature Specification: Оновлення Soty на macOS з вебінтерфейсу

**Created**: 2026-11-12
**Branch**: `feature/macos-trusted-updates`
**Status**: Draft; розробку відновлено власником після релізу. Нативний updater ще не реалізований.

## Джерело та межі

Це продовження нативної частини [початкової 048](original-048-spec.md), збереженої без змін разом з [доказами дослідження](original-048-evidence.md). Підпис, hardened runtime, нотаризація й staple належать [048 Apple trust](../048-macos-apple-trust/spec.md). Ця спека не дублює їх і не трактує членство Apple як доказ готовності пакета.

Власник 2026-11-12 доручив продовжити розробку в окремій гілці та налаштувати Apple Developer через Chrome. База нового воркдерева — `release/1.4.3` у `a7e30bca`; реалізація trust інтегрується з `048-macos-apple-trust` у `b58259d9`. Це походження коду, не підтвердження публікації саме цих байтів. Production не активується в межах цієї роботи.

## User scenarios

1. **P1 — Оновити з hosted або local UI.** Локальна Soty знаходить і завантажує довірений кандидат своєї архітектури. UI показує версію й стан. Одна згода запускає встановлення й перезапуск. Після reconnect перевірено точний build; лише тоді видно успіх. Закриття вкладки не скасовує прийнятий намір.
2. **P1 — Зберегти роботу.** Після згоди нові операції не приймаються, усі активні інструменти, записи, передачі та background/team-операції завершуються штатно. Користувач може відкласти установку до заміни; timeout не вбиває роботу. Черга відновлюється з перевіркою прав і ownership, підтверджені побічні ефекти не повторюються.
3. **P1 — Відновитися після збою.** Fault injection на download, перевірці, drain, заміні й restart залишає цілий довірений пакет або доведений шлях recovery. Невідомий outcome спершу звіряється. Старий процес або інша копія не доводить успіх. Після запуску нового runtime автоматичний downgrade заборонений.
4. **P2 — Одноразовий legacy-перехід.** Без native capability web показує чинний installer handoff. Після bootstrap два послідовні A→B оновлення проходять без ручного DMG. Windows, dev і beta зберігають ізоляцію.

Детальні Given/When/Then та edge cases початкової 048, US3–US6, лишаються acceptance-входом. Apple enrollment з US1 замінено фактичним станом у [continuation.md](continuation.md); Apple trust з US2 приймається окремо за 048.

## Functional requirements

- **FR-001 — Довіра.** Чинний підписаний release manifest і перевірена ідентичність видавця зв'язують версію, source/build, архітектуру та незмінні байти кандидата. Пошкодження, downgrade, відкликання, чужа команда або невідповідна платформа відхиляються до зміни встановлення.
- **FR-002 — Згода.** Фонове завантаження не дає згоди на встановлення. «Пізніше» лишає стару версію працездатною. Кнопка й меню macOS керують одним авторитетним наміром; web не передає довільний шлях або URL виконуваного файла.
- **FR-003 — Ідентичність і авторизація.** Команда доступна лише через чинний authenticated transport і дозволений origin, на тому самому Mac, для однозначно визначеного встановлення. Повтор, дві вкладки й втрачена відповідь не створюють паралельних замін.
- **FR-004 — Глобальний drain.** Готовність компресора не є глобальним idle. Перед заміною доведена зупинка admission і завершення всіх власників роботи. Невідомі зовнішні результати блокують небезпечний replay; відкладання відновлює admission.
- **FR-005 — Durable state.** Прийнятий кандидат, намір, спроба, остання доведена стадія й результат переживають старий/новий процес, закриття web та reboot. Черги відновлюються без втрати користувацьких намірів або дублювання завершеної роботи.
- **FR-006 — Заміна.** Працюючий bundle не переписується частинами. Межі commit/cancel явні; на контрольованих збоях зберігається цілий довірений пакет. Raw paths, кілька копій, DMG/read-only, translocation, відсутність місця та прав мають безпечну відмову. Пароль/Touch ID не збираються Soty; OS-consent штатний, без циклічних повторів.
- **FR-007 — Готовність.** Native-success потребує точного target build та готовності інструментів; UI-success додатково потребує видимого підтвердження у web. Bounded readiness deadline веде до recovery, а не relaunch-loop. До запуску нового runtime відновлення старого пакета дозволене лише з доказом відсутності змін даних.
- **FR-008 — Ресурси.** Bounded download/retry/backoff, власні temp-файли, обмежений cache, sleep-aware очікування. Child processes і дедлайни проходять platform/power seams. Чужі застосунки, релізи та перевірки не зупиняються.
- **FR-009 — Release integration.** Артефакт updater, його залежності й ключі мають відтворюване походження та запечатаний пакет. Поточні next/promote/rollback з 051 лишаються авторитетними; альтернативного каналу, який обходить promote, немає. Відкат вебканалу сам по собі не дає дозволу на downgrade встановленого агента.
- **FR-010 — Acceptance.** Потрібні packaged A→B у hosted/local UI, негативні довірчі контроли, crash/reboot на межах заміни, повтори, busy/defer/cancel, збереження даних і Windows regression. Apple Silicon — runtime, Intel — окрема ціль із чесним позначенням static/native доказів за 049. Відсутність hardware не перетворюється на pass.

## Analytics & diagnostics

Обов'язкові AD-001–AD-010 [початкової 048](original-048-spec.md) і вимоги [031](../031-platform-autoanalytics/spec.md): flow/operation/attempt та installation IDs пов'язують старий runtime, updater, новий runtime і UI. Стадії: offer → download → verified/rejected → consent → drain → replacement committed → relaunch → target ready → web reconnected → result visible. Native та UI outcomes окремі; пропущені стадії не реконструюються як факти.

Закриті failure codes входять у shared типи та analytics code map. `updates`, `investigate`, `inspect`, `journal`, `diagnose`, `audit`, `cohorts` мають пояснювати контрольні спроби read-only, з freshness/delivery lag, missing signals і явним unknown. Жодних secrets, Apple identity, user content, raw paths або provider payloads. Gatekeeper до старту та невідправлений локальний журнал лишаються blind spots з безпечним локальним evidence fallback. Capability inventory оновлюється лише після producer→transport→CLI регресій.

## Success criteria

- Два послідовні переходи після bootstrap потребують однієї згоди кожен і не потребують ручного DMG.
- У всіх busy/fault/replay контролях немає втрати результатів, kill активної роботи або повтору доведеного зовнішнього ефекту.
- У 20 контрольних успішних спробах p95 safe-idle→target-ready+visible-result ≤60 с; download, OS-consent і час активної роботи вимірюються окремо.
- Read-only діагностика пояснює кожну контрольну спробу; непідтверджена стадія ніколи не стає success.

## План і докази реалізації

Технічний дизайн визначено в [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md) і [native contract](contracts/native-updates.md). Sparkle 2.10.1 використовується лише після згоди та workload barrier; predownload Soty не озброює Sparkle. Звичайний quit, second-download identity binding, durable recovery і nested-helper signing ще потребують implementation proofs. До цих доказів capability не додається. [Quickstart](quickstart.md) визначає приймання, не заявляє його виконаним.
