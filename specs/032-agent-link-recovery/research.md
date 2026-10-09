# Research: зв'язок браузер ↔ Soty Agent

**Date**: 2026-10-10 · **Spec**: [spec.md](./spec.md) · **Method**: читання коду (два незалежні аудити: агент і веб), read-only аналітика за 30 днів, пошук по документації WebKit. Жоден пункт не відтворено на реальному Safari; відтворення — завдання плану (quickstart §1).

## 1. Архітектура, як вона є

| Шар | Файл | Що робить |
| --- | --- | --- |
| Власник стану | `apps/web/src/AgentContext.tsx` | `establish()` — одна спроба: `connect()` → (entitlement) → `applyState`; станова машина `ConnectionState` (`connection.ts:6-16`); `reconnect()`; аналітика переходів |
| HTTP | `apps/web/src/api/client.ts` | `request/requestBody/uploadForm` → `assertOk`; 401 → `PairingRequiredError(true)`; `connect()` читає `/api/health` + `/api/queue` |
| Токен | `apps/web/src/api/pairing-token.ts` | `localStorage.agentToken`; фрагмент URL → `verifyPairingToken`; broadcast між вкладками; бюджет автоспарювання 2/хв; `handshakeForToken` (iframe, 4 с) |
| Потік | `apps/web/src/api/stream-client.ts`, `event-stream.ts`, `useAgentEventStream.ts` | один `fetch`-потік на процес, канали, backoff 0.5→8 с, паркування після 60 с приховування; fallback — `EventSource` на 8 per-tool URL із `?token=` |
| Агент: авторизація | `apps/agent/src/server/app.ts:248-372` | Host loopback-only; Origin allowlist лише для `/api/*`; токен у заголовку або `?token=`; 401 `Invalid session token.`; ліміт 20 невдач/хв на IP до перевірки токена; entitlement 403 `ENTITLEMENT_REQUIRED` |
| Агент: токен | `apps/agent/src/server/session-token.ts` | 32 байти hex, файл 0600 у App Support, зберігається між перезапусками; при збої запису — in-memory per-boot |
| Агент: потік | `apps/agent/src/server/stream.ts`, `sse.ts` | `/api/stream?channels=`; снапшот на підписку; heartbeat `: heartbeat` кожні 15 с; ліміти 8/канал, 32/процес із витісненням найстаршого (`event: replaced`); per-tool `EventChannel.handler` без heartbeat і лімітів |
| Агент: спарювання | `app.ts:501-573` | `/pair` → 302 на `pairOrigin#agentToken`; `/local?to=` → 302 на `127.0.0.1:<port><to>#agentToken`; `/pair/handshake?nonce` → HTML з `postMessage` на `pairOrigin`, CSP `frame-ancestors pairOrigin` |
| Агент: зупинка | `apps/agent/src/index.ts:537-621` | `shutdown()` чекає `app.close()` → `process.exit(code)`; `ChannelHub.closeAll()` ніде не викликається |

Два походження сторінки (`apps/web/src/lib/config.ts:150-174`): hosted (https) і локальна копія `http://127.0.0.1:43120`. У кожного власні `localStorage` (токен), `sessionStorage`, сесія Supabase, installation id аналітики.

## 2. Дефекти, виведені з коду (підтверджені двома читаннями)

| ID | Дефект | Де | Наслідок для користувача |
| --- | --- | --- | --- |
| W1 | У мультиплексованому режимі `onDisconnect`/`onReconnect` не підключені | `useAgentEventStream.ts:47-53`; `AgentContext.tsx:311-322` | Стан лишається `connected` після зупинки агента; `establish('retry')` ніколи не стартує; `agent_disconnected` майже не емітиться (32 проти 554 за 30 днів) |
| W2 | Клієнт потоку отримує токен один раз (`[connectedOnce, multiplexed]`) | `AgentContext.tsx:302-309`; `stream-client.ts:98-104,150-187` | Після спарювання з новим токеном потік нескінченно отримує 401; живі події транскрибації/стітчера/живлення мертві, HTTP працює |
| W3 | Немає сторожа бездіяльності читача | `event-stream.ts:53-55` | Напівмертвий сокет після сну → «підключено» без подій назавжди |
| W4 | `verifyPairingToken` відкидає токен при недосяжності | `pairing-token.ts:261-281` | Валідний токен із фрагмента губиться, якщо агент ще стартує; далі бюджет автоспарювання 2/хв |
| W5 | `establish` без загального таймауту; `ensureAgentEntitlement` без таймауту; `connecting.current` блокує `reconnect()` | `AgentContext.tsx:147-160,168` | Зависла спроба робить кнопку «мертвою» |
| W6 | `ENTITLEMENT_UNAVAILABLE` → `entitlement_blocked` без повтору | `AgentContext.tsx:246-249` | Коротка недоступність Edge Function блокує інструменти, хоч агент у пільзі |
| W7 | `teamWorkspaceAvailable` = `connected && compatible` → булеве | `AgentContext.tsx:450-451`; `LibraryProcessingProvider.tsx:261`; `ProcessLibraryDialog.tsx:185-213`; `ProcessMaterialDialog.tsx:123-127` | «Оновіть Soty» при звичайному розриві; «Soty не запущений» при застарілому агенті в меню дій (`team/materials/actions.ts:247`) |
| W8 | `AccountPage` показує «Під'єднати» лише поки `agentVersion` null; версія не скидається | `pages/AccountPage.tsx:478-535`; `AgentContext.tsx:185-190` | Після першого підключення кнопка зникає назавжди; стара версія виглядає поточною |
| W9 | `failureState()` знає лише Chrome-permission; Safari → `not_installed_or_not_running` | `connection.ts:82-96` | У Safari ніколи не показується «браузер блокує», лише «не підключено» |
| W10 | `apiVersion ?? 0` → `agent_update_required` | `client.ts:853`; `connection.ts:19-24` | Будь-який 200 без `apiVersion` = «оновіть агента» |
| W11 | Жодної дії перепідключення під `team/`; бейдж у шапці без дії | `App.tsx:908-930`; весь `team/` | Тупик у просторі |
| W12 | Сторінки інструментів ковтають помилку початкового читання | `TranscriptionPage.tsx:228-239`; `StitcherContext.tsx:63-75`; `LandingOptimizerPage.tsx:117-139` | «Недоступно» без пояснення після відновлення |
| W13 | Немає `pageshow`/`online` слухачів для агента; видимість лише для маніфесту | `AgentContext.tsx:399-407` | Після bfcache/мережі ніхто не перевіряє з'єднання |
| W14 | `useTeamLandings.agentPaired = connectedOnce` не скидається | `useTeamLandings.ts:133` | Галерея вважає агент спареним після розриву |
| A1 | `shutdown()` чекає `app.close()`, а відкриті SSE не закриваються; `forceCloseConnections` не задано; `closeAll()` не викликається | `index.ts:602-621`; `app.ts:226-234`; `sse.ts:209-219` | Процес висить, порт закритий; старий процес шле heartbeat → інтерфейс «підключено» із замороженим станом; лаунчер не отримує код; оновлення не завершується. **Виведено з коду, не відтворено** |
| A2 | handshake дозволяє фрейм лише `pairOrigin` (hosted) | `app.ts:501-505,555-569` | У локальній копії (шлях Safari) in-page спарювання завжди падає в повну навігацію — втрата стану сторінки |
| A3 | Ліміт невдалих авторизацій: ключ `ip`, перевірка до токена, лише успіх скидає | `app.ts:345-364` | Стара вкладка (401 у циклі) вибиває 429 новій |
| A4 | `http://localhost:<port>` не в allowlist Origin | `apps/agent/src/config.ts:80-84` | Локальна копія через `localhost`: GET працює, POST → 403 |
| A5 | Витіснення клієнта (`event: replaced`) не розпізнається клієнтом | `sse.ts:228-252`; `event-stream.ts:71-90` | Два клієнти понад ліміт витісняють один одного в циклі |
| A6 | Після оновлення агента стара вкладка локальної копії отримує `index.html` замість чанка | `app.ts:487-498,574-578` | Маршрут падає до перезавантаження |
| A7 | Краш із кодом ≠ 75/76 не перезапускається лаунчером | `packaging/Launcher.swift:873-881` | Інтерфейс має зійтися до «не запущено», а не «перепідключаємось» |

## 3. Safari: що відомо

- WebKit не вважає `http://127.0.0.1` / `http://localhost` потенційно довіреними у змішаному контенті — fetch/XHR/iframe з https-сторінки блокуються. Трекер: [WebKit 171934](https://bugs.webkit.org/show_bug.cgi?id=171934). У Safari 18 блокування посилилося (неапгрейджуваний змішаний контент): [WebKit 279249](https://bugs.webkit.org/show_bug.cgi?id=279249); у 17.5 частина сценаріїв працювала. Статус у дзеркалах трекера суперечливий — перевірити на реальному Safari 18 (quickstart §1.1).
- Навігація верхнього рівня на `http://127.0.0.1:43120/local` дозволена; саме так працює «Відкрити в Soty» і тому Safari-користувачі живуть у локальній копії (`specs/022-video-catalog-sheet/findings.md:109-114`).
- `navigator.permissions.query({name:'loopback-network'})` у Safari кидає → `failureState()` завжди «не встановлено/не запущено».
- У фоні Safari заморожує таймери; після пробудження сокети можуть лишатися напівмертвими без помилки (загальні джерела про SSE/fetch після suspend; для macOS Safari прямого підтвердження не знайдено). Висновок: сторож heartbeat і перевірка на `visibilitychange`/`pageshow`/`online` потрібні незалежно від того, що саме робить Safari.
- Рішення: ця спека не додає HTTPS агенту. Hosted-походження в Safari отримує чесний стан `blocked_by_browser` і одну провідну дію «Відкрити в Soty»; усі сценарії відновлення мають працювати в локальній копії.

## 4. Аналітика (read-only, 30 днів до 2026-10-09)

| Факт | Значення | Інтерпретація |
| --- | --- | --- |
| `agent_connected` | 554 подій / 21 користувач | кожне завантаження сторінки і кожен успішний `establish` |
| `agent_disconnected` | 32 / 6 | емітиться лише з `connected → disconnected`, а цей перехід на мультиплексованих агентах майже не трапляється (W1) |
| `pairing_*`, `local_app_check_*`, `install_detected`, `compatibility_checked` | 0 — не емітяться ніде | спарювання принципово невидиме |
| friction `update_not_completed` | 15 користувачів / 95 сесій | включає хибні «оновіть» (W7, W10)? — невідомо, бо немає коду причини |
| friction `repeated_blocked_action` | 4 / 6; `blocked_action_attempted` 35 / 8 | частина — спроби відкрити інструмент при від'єднаному агенті |
| errors | жодного кластера з категорією з'єднання | клас помилок цієї спеки не має fingerprint-у |
| cohorts platform | macOS 18 користувачів, Windows 10 | сім'я браузера не збирається — Safari не виділити |
| Guard бази | `analytics_properties_are_safe_v2` має закритий allowlist ключів; відкинута подія повертається клієнту як `accepted=false` і після 3 спроб тихо губиться | нові ключі 032 потребують міграції guard-а; інакше покриття буде фіктивним |

Висновок: поточні дані не дають ні частоти розривів, ні причин невдалих перепідключень, ні частки Safari. Це не «проблем немає», це «сліпа зона» (031 FR-017).

## 5. Рішення

| # | Рішення | Обґрунтування | Відкинуті альтернативи |
| --- | --- | --- | --- |
| R1 | Один власник: `AgentContext` слухає `streamClient.watchConnection` і `streamClient` повідомляє класифіковану причину завершення (`401`, `403`, `429`, `replaced`, `watchdog`, `network`, `closed`) | Конституція VI: один власник транспорту; W1 | Polling health кожні N с — заборонено VI; ще один контекст — дублювання |
| R2 | `streamClient.configure` приймає `token: () => string` (читання під час кожного підключення) + `pairing-token` сповіщає про зміну токена → `restart()` | W2; токен може змінитись і broadcast-ом з іншої вкладки | Перезапуск через deps `useEffect` — пропускає broadcast |
| R3 | Сторож бездіяльності в `readEventStream`: таймер на кожен прочитаний chunk; `heartbeatMs` з health (нове поле, fallback 15 000); поріг `2×heartbeat + 5 000` | W3; читає вже відкритий потік — не polling | `EventSource` має власний retry, але не бачить напівмертвий сокет |
| R4 | `establish` під `AbortSignal.timeout(8 000)` на всю спробу; `reconnect()` при активній спробі позначає «приєднано» і після таймауту перезапускає | W5 | Скасовувати попередню спробу — перегони з applyState |
| R5 | `ENTITLEMENT_UNAVAILABLE` при `reason==='grace'`/`active` → стан `connected` + прапорець `accountCheckPending` із повтором 30 с → 5 хв; `entitlement_blocked` лише на 401/403 сервера або 403 агента | W6; агент сам знає пільгу | — |
| R6 | `toolAvailability(tool) → 'ready' \| 'disconnected' \| 'too_old' \| 'blocked'`; `teamWorkspaceAvailability` аналогічно; булеві поля лишаються як похідні для сумісності | W7, FR-013 | Правити кожну поверхню окремо — повтор помилки |
| R7 | `lastKnownAgent` (версія, білд, контракти, instanceId, seenAt) окремо від `agentVersion` поточного з'єднання; на розриві `agentVersion` не скидається, але UI читає `connection` першим | W8 | Скидати версію — ламає `releaseBlocked` і вибір «відкрити/завантажити» |
| R8 | `failureState()`: якщо `agentKnown()` і hosted-походження і помилка проби — `TypeError` до 50 мс без мережі або `document`-ознаки WebKit (`'safari' in window` / UA без Chrome) → `connection_blocked` | W9; без Chrome-only API | UA-sniffing лише — ненадійно; комбінація ознак |
| R9 | handshake: `frame-ancestors` і `targetOrigin` = Origin/Referer запиту, якщо він у allowlist агента; інакше `pairOrigin` | A2 | Дозволити `*` — токен витече на будь-яку сторінку |
| R10 | `shutdown()`: `hub.closeAll()` + закриття per-tool каналів + `forceCloseConnections: 'idle'` + жорсткий таймер 3 с → `process.exit` | A1 | Лише `forceCloseConnections:true` — рве активні upload-и без відповіді |
| R11 | Ліміт авторизацій: ключ `ip + sha256(token)[:8]`, перевірка після `tokensMatch` для невдач; успіх не чистить чужі лічильники | A3 | Прибрати ліміт — відкриває brute force |
| R12 | Додати `http://localhost:<port>` до allowlist | A4; мінімальний ризик — той самий хост | Редирект на старті — ламає закладки |
| R13 | `event: replaced` → клієнт розпізнає іменовану подію (`event-stream.ts` парсить `event:`), чекає 5–30 с із наростанням і повідомляє власника причиною `replaced` | A5 | — |
| R14 | Аналітика: події FR-025/026 через typed seam; міграція guard-а додає ключі `link_origin`, `browser_family`, `link_reason`, `link_transport`, `link_trigger`, `recovery_mode`, `surface`, `instance_changed`, `token_changed`, `pairing_method`, `duration_ms` (bounded); CLI `connection`; `journey` без змін формату | FR-024…028; §4 | Класти все в `error_code` — втрачає структуру |
| R15 | A6, A7 — поза обсягом коду цієї спеки, задокументовані як відомі; A7 покривається станом `not_running` + стабільним повідомленням | Обсяг | — |

## 6. Edge-case catalogue (повний)

Кожен пункт → сценарій у quickstart або «поза обсягом» (позначено ⊘).

1. Перезапуск агента, токен незмінний → US1.1.
2. Перезапуск, токен змінився (файл не записався / каталог змінено / beta reset) → US1.2.
3. Перезапуск під час задачі → задача `interrupted`, знімок із новим `instanceId` приймається (FR-005).
4. Оновлення агента: драйн → 76 → новий білд → US5.1; стара вкладка локальної копії з чужими чанками ⊘ (A6, відомо).
5. Краш із кодом ≠ 75/76 → стабільне `not_running` (US1.6), ⊘ автоперезапуск.
6. Сон/пробудження → US1.3 (сторож).
7. bfcache / `pageshow` / `online` → US1.4.
8. Приховування > 60 с → паркування, відновлення без банера.
9. > 6 вкладок на хост → US4.4; > 8 на канал → US5.3; > 32 на процес → те саме.
10. Два походження в одному браузері → різні токени/сесії; broadcast не перетинає походження (тест).
11. Токен у фрагменті при агенті, що ще стартує → FR-019 (утримання 30 с, 3 повторні перевірки).
12. Автоспарювання в циклі (прийнято → відхилено) → бюджет 2/хв лишається; ручна дія поза бюджетом.
13. 429 через чужу вкладку → US5.2.
14. Entitlement протермінувався посеред сесії → 403 на tool-маршрутах при живому потоці → `link_inconsistency` + перехід у `account_check_required` (FR-026).
15. Годинник зсунуто → `ENTITLEMENT_TOKEN_INVALID` → повідомлення про час на комп'ютері (новий текст), не «оновіть».
16. Edge Function недоступна в пільзі → US3.4.
17. Локальна копія без сесії акаунта → звичайний вхід; поза обсягом змін.
18. `apiVersion` відсутній / сторонній сервіс → US3.3.
19. Порт зайнятий / друга копія → `not_running` з текстом «Soty запускається» (health недоступний) ⊘ окремий стан.
20. Origin `localhost` → US4.3.
21. Вихід із акаунта з відкритим потоком → `streamClient.configure(null)` (є); вхід → `establish`.
22. Відповідь попереднього екземпляра з нижчою ревізією → `instanceId` скидає лічильник (є, FR-005 перевірка тестом).
23. `reconnect()` під час спроби → US2.3.
24. Безкінечне «перепідключаємось» → US1.6 (після 30 с — `not_running` із рідкими спробами).
25. Браузер офлайн, loopback живий → локальні інструменти працюють; онлайн-перевірка відкладена (US3.4).
26. Hosted + Safari → US4.1.
27. Витіснення `replaced` → US5.3.
28. Per-tool `EventSource` fallback (старий агент без `event-stream`) → наявна логіка; регресія не допускається (тест `agent-disconnect-ui` лишається).

## 7. Відкриті питання, які закриває quickstart, а не спека

- Q1: Чи Safari 18.x на macOS 15 справді блокує `fetch` до `http://127.0.0.1:43120` з https (очікування: так). Якщо ні — R8 нешкідливе.
- Q2: Чи A1 відтворюється (очікування: так; `node` ≥ 19 `server.close` не закриває keep-alive з активною відповіддю).
- Q3: Реальна тривалість до помилки читача після сну в Safari (визначає, чи 35 с сторожа достатньо).
