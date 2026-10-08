# Implementation Plan: Автономний локальний реліз із панеллю прогресу

**Branch**: Поточна `028-manual-sync-lifecycle`; нова гілка не створюється. Feature directory: `029-autonomous-release-panel`.

**Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: `specs/029-autonomous-release-panel/spec.md`

## Summary

Розширити чинний release runner одним локальним контролером. Контролер володіє дорученням і призначенням, стежить за воркером, автоматично доставляє ремонтні завдання Codex, незалежно перевіряє виправлення й відновлює виконання. Окрема локальна панель отримує snapshot і SSE-події; модель не залучається до прогресу, heartbeat, очікування чи спостереження GitHub.

Обраний provider — встановлений Codex app-server через stdio з керованою ChatGPT-автентифікацією. Він запускається тільки для прийнятого ремонту або фінального підсумку. Версію протоколу закріпити на підтвердженій інсталяції; мережевий сервер Codex не відкривати. `codex exec` — досліджена альтернатива, не другий автоматичний fallback.

Дизайн завершено. Реальний unattended repair та ізоляція agent tools ще не доведені: це перший обов’язковий гейт реалізації. План не підміняє його інбоксом і не дозволяє production-запуск.

## Technical Context

**Language/Version**: Node 22, ESM `.mjs` + checked JSDoc для scripts; TypeScript strict для контрактів/UI; чинні React/Vite/Tailwind версії.

**Primary Dependencies**: Наявні runner/bridge/admission, Node filesystem/HTTP, macOS launchd, Codex CLI 0.161.0/app-server, `gh`, web UI inventory. Нових платних сервісів або npm workspace немає.

**Storage**: Hash-chained `journal.ndjson`, atomic snapshots; task/job records у gitignored `release/automation/`, права 0700/0600. Без production-таблиць і міграцій для панелі.

**Testing**: Vitest, existing release fixtures, DOM-тести, fault-injection subprocess tests; controlled actual provider smoke без production-доступу; повне sandbox acceptance.

**Target Platform**: Maintainer macOS Apple Silicon; чинний Windows GitHub Actions. Панель на `127.0.0.1:43150`, порт перевіряється; без production auth.

**Project Type**: Operational CLI/controller + окремий static frontend entry у web workspace.

**Performance Goals**: Update p95 ≤2 с; heartbeat кожні 10 с, stale за 30 с; repair acceptance p95 ≤60 с за доступного provider; observer/controller/panel overhead ≤1% сукупного CPU і ≤200 MiB RSS.

**Constraints**: Один важкий локальний крок; canonical runbook; keys поза CI/repair tools; 0 monitoring model calls; 3 repairs/cause, 6/task; no paid fallback; no approvals/sandbox bypass.

**Scale/Scope**: Один власник, один активний task/target, один repair agent; історія ≥30 днів. Додаткові вкладки не запускають нових GitHub watchers чи моделей.

## Constitution Check

До research і після design: **PASS за обраним дизайном; runtime/production readiness не заявлено**.

| Принцип                 | Design constraint                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Typed boundaries     | Versioned discriminated contracts; unknown→validated events/records/provider responses; pinned generated schema.                               |
| II. Release identity    | Registry `steps.mjs` єдине джерело порядку; shared release identity не дублюється. New source SHA→new run ID, exact-SHA gates зберігаються.    |
| III. Least privilege    | Local session capability; restricted READ/WRITE/network tool profile; secrets поза repair context. Production effects тільки canonical runner. |
| IV. Processes/resources | Fixed executable/argv, shell:false, bounded output; tracked own children, safe termination; repair checks через existing admission.            |
| V. HTTP                 | Snapshot або `{ error: STABLE_CODE }`; explicit statuses; operational server не додає exemptions до product agent.                             |
| VI. UI/state            | Inventory/tokens/i18n; один SSE subscribe/reconnect owner для panel; без recurring client polling або product-agent duplicate gateway.         |
| Governance              | Existing verify/release/G0/sandbox gates; zero new production authorization from planning.                                                     |

Якщо feasibility не доведе permissions або provider access, автономність не допускається; обмеження не послаблюються. Порушень, які потребують constitution amendment, дизайн не передбачає.

## Project Structure

### Documentation (this feature)

```text
specs/029-autonomous-release-panel/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── controller-panel.md
│   ├── repair-provider.md
│   └── progress-recovery.md
└── checklists/requirements.md
```

`tasks.md` належить наступній фазі `speckit-tasks`.

### Source Code (planned, not created)

```text
scripts/release-controller.mjs
scripts/release-runner.mjs                  # existing start/resume convergence
scripts/release-worker.mjs                  # existing executor + observations
scripts/release-bridge.mjs                  # legacy bridge normalization
scripts/install-release-runner.mjs          # explicit controller/provider setup
scripts/lib/release/
├── controller.mjs
├── task-store.mjs
├── target-ownership.mjs
├── progress.mjs
├── observation.mjs
├── panel-server.mjs
├── repair-dispatch.mjs
├── repair-budget.mjs
├── codex-provider.mjs
└── [existing journal, state, handoff, metrics, admission, adapters]
packages/shared/src/release-automation.ts
apps/web/release-panel.html
apps/web/vite.release-panel.config.ts
apps/web/src/release-panel/
├── main.tsx
├── ReleasePanel.tsx
├── ReleasePanelProvider.tsx
├── client.ts
└── components/
packaging/release/controller-launchagent.plist.template
config/release-automation-policy.json
tests/release-controller-*.test.ts
tests/release-panel-*.test.tsx
tests/release-repair-*.test.ts
release/automation/                        # ignored runtime/assets
```

**Structure Decision**: Independent panel entry у чинному workspace використовує inventory/style cascade/i18n, не імпортує `Root`, product auth/Supabase/routing. Static assets готуються при install, Vite не працює під час release. Entry не входить до Cloudflare dist або packaged user agent; negative build-contract test це перевіряє.

## Phase 0 — Research

[research.md](./research.md) фіксує read-only факти, альтернативи й рішення. Під час планування виконано CLI/help/auth/schema checks без модельного turn. Research agent за інструкцією навички перевірив runner seams без записів. Runtime smoke — acceptance gate, не невирішений вибір користувача.

## Phase 1 — Architecture

```text
User request → initiating agent → accepted task/intent
                                      │
                              Local controller
                              ├─ target ownership/recovery
                              ├─ canonical worker → release effects
                              ├─ snapshot + SSE → local panel
                              └─ repair outbox → Codex app-server
                                                    │
                              independent gates ← patch/result
                                      │
                         resume / new candidate / owner blocker
                                      │
                     canonical live verification → final report
```

Controller запускає/відновлює canonical worker, не виконує свою release sequence. Worker — єдиний writer execution journal; controller має task journal. Heartbeats ephemeral, без fsync кожні 10 с. Durable changes atomic і fenced.

### Agent lifecycle and token budgets

Одна thread/job; explicit thread/turn IDs, не `resume --last`. Provider тільки active repair/final summary, без idle turn. Cumulative usage notifications dedupe; totals не складаються повторно. Новий job не отримує весь chat/release history. Agent завершив turn→controller сам запускає gates і чекає.

Defaults: 3 repair attempts/cause, 6/task; 80 000 provider-reported total tokens/attempt, 300 000/task; 20 хв активного turn/attempt, 90 хв/task. Це engineering caps, не ціна/гарантована квота. Started interrupted/failed turns рахуються; transport failure до turn — тільки delivery retry. Ліміти застосовуються за usage notifications; in-flight overshoot можливий і звітується, нульова похибка не обіцяється. Missing live usage не проходить capability gate обраного профілю.

Причина на task нормалізується незалежно від SHA/raw message, щоб новий кандидат не обнуляв бюджети. Deadline/network retries не запускають модель без нової проблеми.

### Repair trust boundary

Окремий checkout без keys/env/runtime records; sanitized env. Цього недостатньо: agent tools мають restricted READ/WRITE paths і network. Потрібний profile перевіряється canaries на absolute paths/symlinks/secret storage, не лише write sandbox. Trusted app-server auth не передається tool subprocess.

Production signing, publishing, migrations і deploy виконує runner, не модельна shell-команда. Agent повертає patch/result; controller перевіряє diff/inputs/policy. Repair tests проходять job-scoped admission broker або deferred independent gate. Dynamic tools не є залежністю: installed schema не підтвердила цей experimental field. За неможливого READ isolation — feasibility failure, no danger-full-access.

Approval routing приймає лише конкретні попередньо дозволені локальні дії за policy; невідомий запит відхиляється й формує blocker. Blanket autoapproval та bypass flags заборонені. Надана авторизація не замінює технічну ізоляцію.

### Panel/security/observations

Bind 127.0.0.1:43150; fragment одноразового bootstrap token→HttpOnly SameSite=Strict cookie, fragment очищається. Host/Origin/Fetch-Metadata + session checks; no CORS/external scripts/frames; CSP і no-store. Logs escaped/ bounded через opaque refs, не довільний file path. Same-origin snapshot/SSE, один owner client.

Initial/reconnect/foreground snapshot read reconciles revision/sequence із SSE. Controller tail перевіряє hash chain інкрементально, filesystem watch лише wakeup hint; bounded low-frequency integrity fallback без моделі. Worker heartbeat відокремлений від controller/server heartbeat, admission lease і command progress.

GitHub watcher один/run: existing programmatic watch з backoff, rate-limit та timeout; панель не створює watcher. Native command progress окремий nullable факт.

### Frozen progress/resource budget

Applicable plan із 15 registry steps, optional backend exclusions за verified plan. Weights із calibrated resource estimates; fallback=1/low confidence. Наступні кандидати використовують median останніх 10 валідних step durations для profile. Weights frozen/candidate; completed validated work змінює confirmed percent. Не завершений overall стан ≤99%, canonical final acceptance→100%. Invalidation/new candidate може зменшити progress лише з visible reason.

Один release admission для worker і repair validation, heavy commands via nice -n 15. Controller/agent reasoning не займають heavy slot. Немає другого suspend manager. Sleep не рахується active work; impossible reserves/unknown signals не чекаються безмежно й не послаблюються мовчки.

### Recovery and completion delivery

Explicit install додає launchd user agent. Відновлення після login/wake: owner identity PID/start/boot перевіряється, alive worker adopt, absent→reconcile/start, ambiguous→blocker. Target-level lock додатково до run lock. Cancellation generation відкидає late results.

Initial desktop chat не є виконуваним backend. За supported origin adapter результат може прийти в нього; інакше persisted panel/report та окрема кінцева Codex-сесія містять підсумок. План не обіцяє unsupported injection у довільний chat. Delivery failure підсумку не скасовує перевірений release completion.

## Delivery sequence and gates

1. **G1 — provider feasibility**: read-only health/version/auth; real isolated repair smoke без chat, no paid API, actual usage/interrupt, READ/network canaries. Failure — explicit blocker, не paid fallback.
2. **G2 — durable controller**: target lock, atomic claim, legacy mapping, outbox/result collection, shared start/reconcile operation, crash adoption. Lost submit/accept/result та concurrent ownership tests.
3. **G3 — observations**: journal payload normalization, canonical metrics, frozen plan, dedicated worker heartbeat, incremental projection, remote correlation.
4. **G4 — panel**: independent build, security, snapshot/SSE races, accessible states, bounded logs; production-exclusion test.
5. **G5 — repair lifecycle**: policy-scoped patch, diff classification, independent validation, new-SHA ancestry, budgets across candidates, after-publish restrictions/cancel fences.
6. **G6 — installation/recovery**: explicit install/status/uninstall, launchd user service, restart/wake acceptance. System sleep settings не змінюються.
7. **G7 — acceptance**: три full sandbox passes, repair scenarios, 5/60-min zero-monitoring comparison, CPU/RSS measurement, close-chat and restart. Existing G0/sandbox acceptance зберігаються; production — тільки окреме доручення.

Ранню панель можна демонструвати, але автономність не приймається до G1–G7. Цей план не створює implementation tasks або application code.

## Validation and coverage

| Scope            | Requirements | Evidence                                                                  |
| ---------------- | ------------ | ------------------------------------------------------------------------- |
| Intent/no costs  | FR-001–005   | Invalid source/target, auth-mode guard, no API-key fallback               |
| Control/recovery | FR-006–011   | Target contention, restart, closed-chat smoke                             |
| Repair           | FR-012–022   | Atomic claim, lost results, invalidated evidence, 3/6 budgets             |
| Panel            | FR-023–034   | SSE replay/race, stale vs stalled, progress, keyboard tests               |
| Tokens/resources | FR-035–041   | Invocation counter, 5/60-min waits, cumulative usage, admission, overhead |
| Final/security   | FR-042–048   | Final proofs, cancel fences, redaction/cross-origin/retention             |

Після коду `npm run verify`; перед acceptance `npm run verify:release`. Повторювати affected gates, не всі без причини. Документаційний planning перевіряється formatting/link consistency без важких builds.

## Complexity Tracking

Constitution violations не потрібні. Один controller додає відсутній delivery/result/restart lifecycle. Independent UI entry повторно використовує workspace, inventory й tokens. Pinned app-server adapter обмежує unstable provider protocol, не додаючи нового agent stack.
