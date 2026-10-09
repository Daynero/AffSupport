# Tasks: Стійкий зв'язок браузер ↔ Soty Agent

**Input**: Design documents from `/specs/032-agent-link-recovery/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/link-state.md, contracts/agent-http.md, quickstart.md

**Tests**: вимагаються спекою (SC-008); пишуться поруч із реалізацією, у `tests/`, single-worker.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [x] T001 Створити гілку `032-agent-link-recovery` від `main`; `uptime`; базовий прогін наявних тестів з'єднання (`tests/stream-*.test.ts`, `tests/connection.test.ts`, `tests/*pairing*.test.ts`, `tests/entitlement.test.ts`, `tests/agent-disconnect-ui.test.tsx`) — зелений.
- [x] T002 [P] Додати `heartbeatMs?: number` до `HealthResponse` у `packages/shared/src/types.ts`; `npm run build -w @video-compressor/shared`.

## Phase 2: Foundational (клієнт потоку і власник стану)

- [x] T003 `apps/web/src/api/event-stream.ts`: `readEventStream` отримує `idleMs?` і `onActivity?`; таймер бездіяльності скидається на кожному chunk, спрацювання → abort з причиною `watchdog`; парсити `event:` рядки і віддавати `onNamedEvent(name)`; при `!response.ok` кидати `StreamRefusedError(status)`.
- [x] T004 `apps/web/src/api/stream-client.ts`: `configure({ agentUrl, token: () => string, heartbeatMs? })`; `watchConnection` передає `{ open, reason }`; `StreamEndReason`; `restart()` публічний; 401 → `unauthorized` без повтору; 403 → `forbidden` без повтору; 429 → `throttled` з backoff; `replaced` → backoff `[5000,10000,30000]`; watchdog = `2*heartbeatMs+5000`.
- [x] T005 `apps/web/src/api/useAgentEventStream.ts`: у мультиплексованому режимі підписатися на `watchConnection` і викликати `onDisconnect` (після grace 3 с, один раз на розрив) / `onReconnect` (при `open:false` з причиною, що потребує `establish`) — так само, як fallback.
- [x] T006 `apps/web/src/api/pairing-token.ts`: `storePairingToken` і `verifyPairingToken` сповіщають слухачів навіть у тій самій вкладці; неперевірений токен із фрагмента при недосяжності утримується і перевіряється повторно (3 спроби, 30 с); експорт `onPairingToken` без змін.
- [x] T007 `apps/web/src/connection.ts`: тип `LinkReason`; `versionState` повертає `'connection_failed'`-сигнал для нецілого/відсутнього `apiVersion` (окремо від `agent_update_required`); `failureState()` визначає `connection_blocked` без Chrome-only API (hosted-походження + `agentKnown()` + миттєва `TypeError`), зберігаючи Chrome-permission перевірку.
- [x] T008 `apps/web/src/api/client.ts`: `connect()` кидає `CONNECTION_FAILED` коли `apiVersion` не ціле число; `reportRequestFailure(kind)` і `onRequestFailure(listener)` для 401/403/CONNECTION_FAILED в `assertOk`/`request`.
- [x] T009 `apps/web/src/api/entitlement.ts`: таймаут 6 с на `functions.invoke` через `AbortSignal`; повідомлення `ENTITLEMENT_UNAVAILABLE` при таймауті.
- [x] T010 `apps/web/src/AgentContext.tsx`: власник стану за contracts/link-state.md — `reason`, `attempt {id,startedAt,trigger,stage,joined}`, `lastKnownAgent`, `accountCheckPending`; `establish(trigger)` з таймаутом 8 с; `reconnect(surface)` приєднується до активної спроби; слухачі `visibilitychange`/`pageshow`/`online` з дебаунсом; підписка на `watchConnection` (через T005); `streamClient.configure` з `token: () => pairingToken()` і `heartbeatMs`; на `onPairingToken` → `streamClient.restart()` + `establish('token_changed')`; `ENTITLEMENT_UNAVAILABLE` у пільзі → `connected` + `accountCheckPending` з повтором 30 с → 5 хв; `toolAvailability(tool)`, `teamWorkspaceAvailability`; retry 4 с ×2 потім 15 с; `onRequestFailure` → `link_inconsistency` + `establish('request_failed')`.
- [x] T011 [P] `tests/link-owner.test.tsx` (реальний `AgentProvider` із замоканими `client`/`stream-client`): мультиплексований розрив → `disconnected` після grace → `connected` після повернення з перечитаним health/queue; зміна `instanceId` скидає ревізію; таймаут спроби; друге `reconnect` під час спроби — `joined`; `ENTITLEMENT_UNAVAILABLE` у пільзі не блокує; 401 на потоці → шлях спарювання.
- [x] T012 [P] `tests/stream-client-token.test.ts`, `tests/stream-watchdog.test.ts`, `tests/stream-replaced.test.ts`: токен читається при кожному підключенні; `restart()` після зміни; 401 без повтору з причиною; бездіяльність > watchdog → reconnect; `event: replaced` → backoff.
- [x] T013 [P] `tests/link-failure-state.test.ts`, `tests/pairing-token-retry.test.ts`: `connection_blocked` без Chrome API; відсутній `apiVersion` → не «оновіть»; утримання неперевіреного токена.

**Checkpoint**: інтерфейс бачить втрату й відновлення на мультиплексованих агентах; потік живе після спарювання.

## Phase 3: US1 — автоматичне відновлення на поточній сторінці (P1)

- [x] T014 [US1] (`lib/power.tsx` і `useLandingViewer` уже перечитують стан на кожному `connected` і показують видиму помилку — без retry-обгортки) `apps/web/src/transcription/TranscriptionPage.tsx`, `stitcher/StitcherContext.tsx`, `landing/LandingOptimizerPage.tsx`, `landing-preview/LandingPreviewPage.tsx` (через `useLandingViewer`), `lib/power.tsx`: початкове читання стану при кожному переході в `connected` і при зміні `attempt.id` успішного відновлення; помилка читання не ковтається — зберігається як `stateError` з повтором 2 с ×3 і видимим станом «стан інструмента не прочитано» + `ReconnectAction`.
- [x] T015 [US1] `apps/web/src/team/landings/useTeamLandings.ts`: `agentPaired` читає `connection === 'connected'`, не `connectedOnce`.
- [x] T016 [US1] Розширити `tests/transcription-page.test.tsx` сценарієм «розрив → відновлення → стан перечитано, ввід увімкнено»; `tests/landing-viewer-source.test.tsx` — причина розриву прокидається.

## Phase 4: US2 — дія «Перепідключити» (P1)

- [x] T017 [US2] `apps/web/src/components/ReconnectAction.tsx` з інвентарю (`Button`, `Chip`/`Spinner`): `surface`, `compact`; pending під час `attempt`; результат 4 с; ніколи не disabled.
- [x] T018 [US2] `apps/web/src/i18n.ts`: ключі `linkReconnect`, `linkReconnecting`, `linkConnectSoty`, `linkConnectSotyBody`, `linkBrowserBlocked`, `linkBrowserBlockedBody`, `linkReasonNotRunning`, `linkReasonPairingRejected`, `linkReasonTimeout`, `linkReasonAccountUnavailable`, `linkAccountCheckPending`, `linkStateNotRead`, `linkClockSkew`, `accountLocalAppLastSeen` — uk та en.
- [x] T019 [US2] Поверхні: `App.tsx` (бейдж у шапці → з дією; банер компресора), `HomePage.tsx`, `pages/AccountPage.tsx` (видимість «Під'єднати» за `connection`, «востаннє відомо v…»), `components/LocalAppDialog.tsx`, `components/PowerReadout.tsx`, `transcription/TranscriptionPage.tsx`, `stitcher/StitcherPage.tsx`, `landing/LandingOptimizerPage.tsx`, `landing-viewer/LandingViewer.tsx`, `team/workspace/WorkspaceShell.tsx` (чип стану агента з дією), `team/preview/MaterialPreview.tsx`, `team/processing/ProcessMaterialDialog.tsx`, `team/library/ProcessLibraryDialog.tsx`.
- [x] T020 [US2] `tests/reconnect-surfaces.test.tsx`: кожна поверхня з FR-010 рендерить `ReconnectAction` при `disconnected`; pending → result; AccountPage показує дію після розриву й не видає стару версію за поточну.

## Phase 5: US3 — правдиві причини (P1)

- [x] T021 [US3] `AgentContext`: `toolAvailability`/`teamWorkspaceAvailability` (T010) → споживачі: `team/library/LibraryProcessingProvider.tsx` (`supportedKinds` не порожній при `disconnected`; окремий прапорець), `team/library/ProcessLibraryDialog.tsx`, `team/processing/ProcessMaterialDialog.tsx`, `team/materials/actions.ts` (`needsAgent` → причина; `materialReasonAgentRequired` лише при `disconnected`, `teamErrorAgentUpdateRequired` при `too_old`), `team/errors.ts`, `HomePage.tsx` tile notes, `components/LocalAppDialog.tsx` (`needsUpdate` лише при `too_old`), `ProtectedSoty.tsx` (`releaseBlocked` лише при `connected`).
- [x] T022 [US3] `tests/link-availability.test.tsx`: для `disconnected`/`too_old`/`ready` кожна з перелічених поверхонь показує правильну копію; health без `apiVersion` → «не вдалося підключитися»; `ENTITLEMENT_UNAVAILABLE` у пільзі → інструменти доступні, банер «перевірка відкладена».

## Phase 6: US5 — агент (P2)

- [x] T023 [P] [US5] `apps/agent/src/server/sse.ts`: `ChannelHub.closeAll(reason)` шле `event: shutdown` і завершує сокети; `EventChannel.closeAll()`; експорт обох.
- [x] T024 [P] [US5] `apps/agent/src/index.ts`: `shutdown()` — `hub.closeAll` + усі `EventChannel.closeAll` → `app.close()` → жорсткий таймер 3 с `process.exit(code)`; `apps/agent/src/server/app.ts`: `forceCloseConnections: 'idle'`.
- [x] T025 [P] [US5] `apps/agent/src/server/app.ts`: лімітер невдач за ключем `ip:sha256(token)[:8]`; збіг токена ніколи не рахується/не блокується; `heartbeatMs` у `/health` та `/api/health`; handshake `frame-ancestors`/`targetOrigin` = Origin/Referer запиту, якщо в allowlist; `apps/agent/src/config.ts`: + `http://localhost:<port>`.
- [x] T026 [US5] `tests/agent-shutdown-streams.test.ts` (реальний Fastify на випадковому порту: відкритий `/api/stream` → `shutdown` → клієнт отримує `event: shutdown` і EOF; процесний таймер не спрацьовує), `tests/agent-auth-limiter.test.ts`, `tests/pair-handshake-origin.test.ts`, доповнити `tests/events-cors.test.ts` для `localhost`.

## Phase 7: US4 — Safari і локальна копія (P2)

- [x] T027 [US4] `App.tsx` `Onboarding`: стан `connection_blocked` — провідна дія «Відкрити в Soty» (`agentLocalUrl()` на поточний шлях), другорядна «Завантажити»; `HomePage`/бейдж — текст `linkBrowserBlocked`.
- [x] T028 [US4] (handshake локальної копії покрито агентським `tests/pair-handshake-origin.test.ts`) `tests/onboarding-recovery.test.tsx` розширити: `connection_blocked` веде «Відкрити в Soty» на поточний шлях; `tests/repair-handshake.test.ts` — локальна копія (origin = agentUrl) проходить handshake.

## Phase 8: US6 — аналітика (P1)

- [x] T029 [P] [US6] `apps/web/src/lib/browser.ts`: `browserFamily()` (`safari|chrome|firefox|edge|other`) без повного fingerprint; `apps/web/src/analytics/events.ts`: імена `link_check_started`, `link_check_completed`, `link_lost`, `link_recovered`, `reconnect_clicked`, `blocked_by_browser_detected`, `link_inconsistency` і ключі `link_trigger`, `link_origin`, `browser_family`, `link_reason`, `link_stage`, `link_transport`, `recovery_mode`, `surface`, `instance_changed`, `token_changed`, `pairing_method`, `duration_ms`, `link_stream_open` з enum/bool/range-санітизацією; `apps/web/src/analytics/link.ts` хелпери.
- [x] T030 [P] [US6] `supabase/migrations/<ts>_link_analytics_keys.sql`: `analytics_properties_are_safe_v2` + нові ключі, enum-и, bool, `duration_ms` 0..86 400 000; `ROLLBACK.md` крок; `supabase/tests/database/link-analytics-guard.test.sql`.
- [x] T031 [P] [US6] `scripts/analytics/{queries,index,format,types}.ts`: команда `connection` за data-model; `docs/ANALYTICS_CLI.md` і AGENTS.md таблиця питань → `connection`.
- [x] T032 [US6] `AgentContext`/`ReconnectAction`/`pairing-token`: емітити події FR-025/026 через `analytics/link.ts`; `pairing_*` у `handshakeForToken`/`verifyPairingToken`/`pairWithAgent`.
- [x] T033 [US6] `tests/link-analytics.test.ts` (клієнтський sanitizer приймає кожну подію; PGlite з реальним тілом guard-функції приймає кожну), `tests/analytics-connection-command.test.ts` (envelope, p50/p95, coverage note, без email/токенів).

## Phase 9: Polish & verification

- [x] T034 `npm run format`, `npm run lint`, `npm run verify` (один процес, `uptime` перед запуском); виправити падіння.
- [ ] T035 (відкрито: потребує Safari 18, Windows і бета-стек; стан у findings.md) Quickstart §1–§2 на реальних середовищах (Safari 18 локальна копія; Chrome hosted; агент macOS/Windows; бета для §2) — записати у `specs/032-agent-link-recovery/findings.md` з датою/білдом; Q1–Q3 закриті.
- [x] T036 Оновити `specs/009-release-hardening-pass/findings.md` (D1/D2/D4/D5 → closed by 032) і `docs/ANALYTICS_CLI.md`; коміт.
