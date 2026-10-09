# Findings: 032 — зв'язок браузер ↔ Soty Agent

**Date**: 2026-10-10 · **Branch**: `032-agent-link-recovery` · **Base**: `main` 8bdad645

## Що зроблено і чим доведено

| Область | Зміна | Доказ |
| --- | --- | --- |
| Власник стану (W1, W5, W6, W13) | `AgentContext`: `reason`, `attempt` (таймаут 8 с, приєднання повторного натискання), `lastKnownAgent`, `accountCheckPending`; `watchConnection` → grace 3 с → `disconnected`; повторна перевірка після grace; `visibilitychange`/`pageshow`/`online`; `onRequestFailure` → `link_inconsistency`; `ENTITLEMENT_UNAVAILABLE` → повтор 30 с → 5 хв | `tests/link-owner.test.tsx` (7) |
| Клієнт потоку (W2, W3, A5) | `token: () => string`, `restart()`, `StreamEndReason`, 401/403 без повтору, 429/replaced із повільним backoff, сторож `2×heartbeat+5 с` | `tests/stream-client-token.test.ts` (6), `tests/stream-watchdog.test.ts` (5), `tests/stream-client-visibility.test.ts` |
| Хук потоку | мультиплексований шлях доповідає `onDisconnect/onReconnect` як fallback | `tests/link-owner.test.tsx`, `tests/agent-disconnect-ui.test.tsx`, `tests/landing-viewer-source.test.tsx` |
| Причини (W7, W9, W10, W14) | `toolAvailability`/`teamWorkspaceAvailability`; `failureState` → `connection_blocked` для Safari на hosted; health без `apiVersion` → збій підключення; `agentPaired` з `connection` | `tests/link-failure-state.test.ts` (6), `tests/link-availability.test.tsx` (9) |
| Дія «Перепідключити» (W8, W11) | `ReconnectAction` на 15 поверхнях; `AgentLinkChip` у просторі; «Акаунт» показує дію після розриву і «востаннє бачили версію» | `tests/reconnect-surfaces.test.tsx` (14), `tests/auth-ui.test.tsx` |
| Інструменти (W12) | `useToolStateRead`: перечитування при кожному `connected`, повтор 2 с ×3, видимий «стан не прочитано» | `tests/transcription-page.test.tsx` (+3) |
| Токен (W4) | неперевірений токен із фрагмента утримується 30 с і перевіряється повторно | `tests/pairing-verify-before-adopt.test.ts` |
| Агент (A1–A4) | `closeAll` + `event: shutdown` + `forceCloseConnections:'idle'` + жорсткий таймер 3 с; лімітер за `ip:sha256(token)[:8]` після перевірки токена; handshake для походження запиту з allowlist; `localhost` в allowlist; `heartbeatMs` у health | `tests/agent-shutdown-streams.test.ts` (3, у т.ч. відтворення A1: без прощання `app.close()` не завершується за 500 мс), `tests/agent-auth-limiter.test.ts`, `tests/pair-handshake-origin.test.ts`, `tests/events-cors.test.ts` |
| Аналітика (US6) | 7 подій, 13 ключів, міграція guard-а `20261110100000_link_analytics_keys.sql` + pgTAP, `browserFamily`, `linkOrigin`, CLI `connection` | `tests/link-analytics.test.ts` (8, PGlite з реальним тілом guard-а), `tests/analytics-connection-command.test.ts` |

A1 (зависання при зупинці) відтворено тестом на реальному Fastify: з відкритим потоком і без прощання `app.close()` не завершується; з `closeAll` — завершується за десятки мілісекунд, клієнт отримує `event: shutdown` і EOF.

## Рішення, прийняті під час реалізації

- Межа `duration_ms` у guard-і — один рік (як у shared-санітайзері команд), а не один день: інакше onboarding-flow, відкритий через день, відкидався б. Клієнт клампить link-події до одного дня сам.
- Після втрати потоку HTTP-перевірка чекає grace (3 с), а не йде негайно: інакше перезапуск агента (≈1 с без відповіді) перетворювався на банер, який grace існує, щоб приховати.
- Handshake, що повернув той самий токен, не запускає негайну нову спробу (це був би цикл без затримки), а планує звичайний retry.
- Boolean-ключі у клієнтському санітайзері тепер строгі для всіх булевих ключів (рядок `"true"` відкидається) — побічна зміна аналітичної підсистеми, задокументована тут.

## Що лишається відкритим (T035; потребує реальних середовищ)

| Пункт quickstart | Стан | Чому |
| --- | --- | --- |
| §1.1 Safari 18 hosted (Q1) | не виконано | немає доступу до Safari у цій сесії; `failureState` трактує Safari+hosted+відомий агент як `blocked` незалежно від результату Q1 |
| §1.2 Safari локальна копія a–h | не виконано | те саме; логіка покрита jsdom-тестами, але сон/пробудження (Q3) і реальний Safari-таймер — лише вручну |
| §1.3 Chrome hosted | не виконано | — |
| §1.4 агент macOS/Windows a–d | частково | a) відтворено тестом на реальному сервері; b) оновлення через лаунчер — вручну; c) лімітер — тест; d) витіснення — тест клієнта |
| §1.5 повідомлення | автоматично | `link-availability`, `reconnect-surfaces`, `onboarding-recovery` |
| §2 діагностика на беті | не виконано | потребує бета-стеку з реальним ingest; guard перевірено на PGlite, CLI — на PGlite |

Поки §1.1–1.3 і §2 не пройдені на реальних пристроях, SC-001…SC-003, SC-005 (Windows) і SC-007 лишаються **непідтвердженими**; SC-004, SC-006, SC-008 підтверджені тестами.

## Verify

`npm run verify` (fast) 2026-10-10 02:50: 14/14 gates passed in 598 s; tests 4547, skipped 10; coverage not measured. Виправлення під час прогону: типізація headers у `tests/pair-handshake-origin.test.ts`, `fakeAgentValue` у `tests/release-update-notice.test.tsx`, allowlist bounded wait для `tests/agent-shutdown-streams.test.ts` у `suite-hygiene`.
