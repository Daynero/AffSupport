# Implementation Plan: Стійкий зв'язок браузер ↔ Soty Agent

**Branch**: `032-agent-link-recovery` | **Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/032-agent-link-recovery/spec.md`

## Summary

Інтерфейс не помічає втрати зв'язку з агентом на сучасних агентах (мультиплексований потік не доповідає власнику стану), не оновлює токен потоку після спарювання, не має сторожа напівмертвого сокета, показує «Оновіть агента» при простому розриві і не дає дії «Перепідключити» у просторі. Агент не закриває потоки при зупинці, тому старий процес може висіти з «підключено». План: один власник стану з'єднання з класифікованими причинами; клієнт потоку з живим токеном, сторожем і розпізнаванням `401/403/429/replaced`; предикати доступності з причиною і спільний `ReconnectAction` на кожній поверхні; у агенті — коректне завершення потоків, лімітер за токеном, handshake для локальної копії, `localhost` в allowlist; аналітика життєвого циклу зв'язку з міграцією guard-а і командою CLI `connection`.

## Technical Context

**Language/Version**: TypeScript strict, ESM NodeNext; Node 22; React 19 + Vite; Fastify 5

**Primary Dependencies**: `@video-compressor/shared` (контракти), HeroUI-інвентар `apps/web/src/components/ui/`, `@fastify/cors`, Supabase JS (analytics RPC)

**Storage**: `localStorage` (токен, прапорці), файл токена агента; Postgres `analytics_events` (без нових таблиць; міграція guard-а)

**Testing**: vitest (jsdom для UI), PGlite для SQL-запитів CLI, `supabase/tests/database/*.sql` для guard-а; single-worker

**Target Platform**: macOS/Windows агент; браузери Safari 18 (локальна копія), Chrome/Edge/Firefox (hosted)

**Project Type**: монорепо web + agent + shared + scripts

**Performance Goals**: розрив видно 3–10 с; відновлення ≤ 5 с; сторож 35 с; жодного нового polling

**Constraints**: конституція VI (один власник транспорту; без polling), V (машинні коди), III (токен лише в заголовку; нічого секретного в аналітиці), дизайн-система (елементи з інвентарю)

**Scale/Scope**: ~15 поверхонь UI, 2 транспорти, 1 міграція, 1 команда CLI, ~10 нових тест-файлів

## Constitution Check

| Принцип | Як дотримано |
| --- | --- |
| I Type-safe | `LinkReason`, `Availability`, `StreamEndReason` — string-literal unions; health-поле `heartbeatMs` перевіряється guard-ом (`typeof === 'number'`) |
| II One source of release/protocol truth | `AGENT_API_VERSION` не змінюється; нове поле health аддитивне; `WEB_TOOL_REQUIREMENTS` не чіпаємо |
| III Security | токен лишається в заголовку/`localStorage`; handshake дозволяє лише allowlist-походження; лімітер не послаблюється, а уточнюється; у подіях аналітики — тільки enum/bool/bounded numbers |
| IV Child processes | не торкається |
| V HTTP conventions | нові відповіді: `event: shutdown`, незмінні коди 401/403/429; `heartbeatMs` у health |
| VI Frontend | один власник (`AgentProvider`) для з'єднання; `streamClient` — один транспорт; сторож читає відкритий потік (не polling); нові елементи з інвентарю; тексти через `TranslationKey`; `analytics.track` typed |
| Verify | `npm run verify`; нові тести в `tests/` |

Порушень немає; Complexity Tracking порожній.

## Project Structure

### Documentation (this feature)

```text
specs/032-agent-link-recovery/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── findings.md            # результати quickstart (створюється під час виконання)
├── contracts/
│   ├── link-state.md
│   └── agent-http.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/web/src/
├── AgentContext.tsx                 # власник стану: reason, attempt, lastKnownAgent, availability, слухачі видимості/pageshow/online, watchConnection
├── connection.ts                    # LinkReason, failureState → blocked_by_browser без Chrome-only API, versionState для відсутнього apiVersion
├── api/stream-client.ts             # token: () => string, watchdog, StreamEndReason, replaced-backoff, restart()
├── api/event-stream.ts              # onActivity, event: lines, StreamRefusedError
├── api/useAgentEventStream.ts       # multiplexed: прокидає watchConnection → onDisconnect/onReconnect
├── api/pairing-token.ts             # утримання неперевіреного токена з повтором; onTokenChanged
├── api/client.ts                    # reportRequestFailure (link_inconsistency)
├── api/entitlement.ts               # таймаут обміну
├── analytics/events.ts              # нові події/ключі
├── analytics/link.ts                # helpers: trackLinkCheck*, trackLinkLost/Recovered, browserFamily(), linkOrigin()
├── lib/browser.ts                   # browserFamily() без повного fingerprint
├── components/ReconnectAction.tsx   # спільна дія
├── App.tsx, HomePage.tsx, pages/AccountPage.tsx, components/LocalAppDialog.tsx, components/PowerReadout.tsx
├── transcription/TranscriptionPage.tsx, stitcher/StitcherPage.tsx, landing/LandingOptimizerPage.tsx, landing-preview/LandingPreviewPage.tsx
├── team/workspace/WorkspaceShell.tsx, team/materials/actions.ts, team/processing/ProcessMaterialDialog.tsx,
│   team/library/ProcessLibraryDialog.tsx, team/library/LibraryProcessingProvider.tsx, team/preview/MaterialPreview.tsx,
│   team/landings/useTeamLandings.ts, team/errors.ts
└── i18n.ts                          # нові ключі (uk/en)

apps/agent/src/
├── server/app.ts                    # heartbeatMs у health; лімітер за токеном; handshake origin; forceCloseConnections
├── server/sse.ts                    # closeAll(reason) з event: shutdown; EventChannel.closeAll
├── config.ts                        # + localhost origin
└── index.ts                         # shutdown ordering + hard timer

packages/shared/src/types.ts         # HealthResponse.heartbeatMs?

scripts/analytics/{index,queries,format,types}.ts   # команда connection
supabase/migrations/<ts>_link_analytics_keys.sql     # guard allowlist + enums
supabase/tests/database/link-analytics-guard.test.sql
docs/ANALYTICS_CLI.md                 # команда connection

tests/
├── link-owner.test.tsx               # multiplexed loss → disconnected → recovered; grace; instanceId reset; attempt timeout; joined reconnect
├── stream-client-token.test.ts       # token getter; restart on token change; 401 → unauthorized без повтору
├── stream-watchdog.test.ts           # відсутність байтів > watchdog → reconnect
├── stream-replaced.test.ts           # event: replaced → backoff
├── link-availability.test.tsx        # предикати з причиною; копія «Підключіть» vs «Оновіть» у діалогах простору/меню дій
├── reconnect-surfaces.test.tsx       # кожна поверхня має дію; pending/result; account page після розриву
├── link-failure-state.test.ts        # blocked_by_browser без Chrome API; apiVersion відсутній → connection failed
├── pairing-token-retry.test.ts       # утримання неперевіреного токена
├── agent-shutdown-streams.test.ts    # closeAll + вихід процесу з відкритим потоком (реальний сервер)
├── agent-auth-limiter.test.ts        # чужі невдачі не блокують чинний токен
├── pair-handshake-origin.test.ts     # frame-ancestors для локальної копії та localhost
├── link-analytics.test.ts            # події проходять клієнтський sanitizer; ключі збігаються з guard-ом (PGlite із guard-функцією)
└── analytics-connection-command.test.ts
```

**Structure Decision**: існуючі модулі; жодного нового пакета. Новий файл `analytics/link.ts` і компонент `ReconnectAction.tsx` — єдині нові сутності у вебі.

## Phase 0 — Research (done)

[research.md](./research.md): 14 веб-дефектів, 7 агентських, Safari-факти, 30-денна аналітика, 15 рішень, каталог 28 крайових випадків, 3 відкриті питання для quickstart.

## Phase 1 — Design

- [data-model.md](./data-model.md): `LinkReason`, `Availability`, `LinkAttempt`, `StreamSession`, події та команда CLI.
- [contracts/link-state.md](./contracts/link-state.md): власник, таймінги, предикати, `ReconnectAction`, API клієнта потоку.
- [contracts/agent-http.md](./contracts/agent-http.md): аддитивні зміни агента.
- [quickstart.md](./quickstart.md): автоматичні перевірки, матриця реальних середовищ, діагностика.

### Ключові дизайн-рішення (деталі в research §5)

1. **Власник отримує все.** `streamClient.watchConnection` → `AgentProvider`; `useAgentEventStream` у мультиплексованому режимі прокидає ті ж `onDisconnect/onReconnect`, щоб існуючі споживачі (`agentLandingSource`) не змінювалися.
2. **Токен — функція.** `configure({ token: () => pairingToken() })`; `pairing-token` емітить `onPairingToken` і при власному `storePairingToken`, і при broadcast; `AgentProvider` на цю подію робить `streamClient.restart()` + `establish('token_changed')`.
3. **Сторож у читачі.** `readEventStream` отримує `idleMs`; таймер скидається на кожному chunk; спрацювання → abort із `reason:'watchdog'`.
4. **Причини замість булевих.** `toolAvailability`/`teamWorkspaceAvailability`; булеві поля лишаються.
5. **Одна дія.** `ReconnectAction` з інвентарю; `reconnect(surface)` трекає `reconnect_clicked`.
6. **Агент виходить завжди.** `closeAll` → `app.close({forceCloseConnections:'idle'})` → таймер 3 с.
7. **Аналітика справжня.** Міграція guard-а + SQL-тест на кожен ключ; CLI `connection`; беті-прохід у quickstart §2.

## Phase 2 — Tasks

Див. [tasks.md](./tasks.md). Порядок: Foundational (shared types, event-stream/stream-client, AgentContext owner) → US1 → US2 → US3 → US5 (agent) → US4 → US6 (analytics) → Polish/verify.

## Complexity Tracking

Порожньо.

## Risks

- A1 (зависання при зупинці) не відтворено; якщо `forceCloseConnections:'idle'` недостатньо, жорсткий таймер гарантує вихід, але лаунчер побачить код виходу від таймера — має лишитись 75/76.
- Safari-поведінка (Q1, Q3) перевіряється лише вручну; автоматичні тести моделюють сокет і таймери.
- Міграція guard-а — forward-only; `ROLLBACK.md` отримує зворотний крок (повернення попередньої версії функції).
