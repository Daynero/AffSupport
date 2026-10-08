# Research: Автономний локальний реліз

**Date**: 2026-10-07 | **Feature**: [spec.md](./spec.md)

Read-only дослідження. Один research agent за вимогою навички планування перевірив runner; основний агент перевірив provider/UI/design. Agent turn, launchd install, beta, release та production-зміни не запускалися.

## R1 — Canonical runner + lifecycle controller

**Decision**: Зберегти runner/15-step registry, додати один resident controller.

**Evidence**: `steps.mjs` володіє порядком/resources/timeouts; worker записує receipts і handoff та виходить blocked. `supervisor.mjs` лише detached spawn. Runtime calls `deliverPendingHandoffs`/`acknowledgeHandoff` не знайдені; acknowledged jobs не потрапляють до `dueHandoffs`.

**Rationale**: Durable execution існує, але немає живого власника repair delivery/result/restart.

**Alternatives considered**: Другий workflow engine додає інфраструктуру; model watch витрачає токени; browser tab не є durable controller.

## R2 — Protocol and ownership gaps

**Decision**: Legacy v1 normalization + versioned internal execution record; atomic claim і target-level ownership.

**Evidence**: Inbox results `repaired/refused/needs_owner` відрізняються від handoff `repaired/cannotRepair/needsExternalDecision`. `submitJob` read-then-replace не гарантує atomic execution claim. Owner lock scope — run directory, не target. `release resume` тільки змінює snapshot; потрібний спільний reconcile/start path.

**Rationale**: Receipt не означає agent started; distinct run IDs не можуть писати в один target. Lost result query не має створювати другого редактора.

**Alternatives considered**: In-place enum rename ламає persisted records; PID-only ownership небезпечне через reuse.

## R3 — Supported local Codex provider

**Decision**: Pinned Codex app-server/stdin-stdout, керований ChatGPT login, job-scoped turns. Не використовувати paid API key або shared desktop socket.

**Local evidence**: `/Users/daynero/.local/bin/codex`; version `codex-cli 0.161.0`; auth status `Logged in using ChatGPT`. Help підтверджує stdio/schema generator/exec JSON/output-schema. Generated schema створено тільки в тимчасовому каталозі без model turn.

**Official evidence**: App-server документує stdio, turn lifecycle, usage updates та interruption, version-specific schemas. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server). Subscription ChatGPT login відокремлений від API key usage-based auth. [Official authentication documentation](https://learn.chatgpt.com/docs/auth). Exec підтримує automation/JSON/schema output і saved CLI auth. [Official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

**Rationale**: Controller може прийняти output/usage і перервати ремонт без idle prompts. Наявна auth не гарантує квоту чи unattended execution.

**Alternatives considered**: Exec простіший, але не обраний для live repair control; scheduled desktop automations не є event job dispatch; unsupported chat injection виключено.

**Compatibility**: Локальна ThreadStartParams schema 0.161.0 не містить documented experimental dynamicTools. Критичний design не залежить від цього поля. Generated schema digest і contract tests закріплюють adapter; не покладатися на newest docs fields без local support.

## R4 — Real smoke is a gate, not an assumption

**Decision**: Перший implementation milestone — реальна isolated fixture: receipt→turn acceptance→patch→structured result→independent test, desktop chat закритий.

**Rationale**: Binary/auth/inbox не доводять autonomous repair. Планування не витрачає quota на пробний turn.

**Pass evidence**: Version/schema/policy digest, non-secret auth mode, timestamps, usage/interrupt, denied secret-read/network canaries, independent result, restart behavior. Capability receipt інвалідується при зміні цих входів.

**Failure policy**: AGENT_AUTH_REQUIRED, AGENT_QUOTA_UNAVAILABLE, AGENT_PROTOCOL_UNSUPPORTED, AGENT_READ_ISOLATION_UNPROVEN, AGENT_UNATTENDED_UNAVAILABLE. No paid fallback, no credits purchase, no sandbox bypass.

## R5 — Secret isolation beyond workspace-write

**Decision**: Clean repair checkout + sanitized env + enforced restricted READ/WRITE/network tool profile.

**Rationale**: Write-only sandbox не доводить захист `config/keys`, original checkout або Codex auth. Prompt заборони не замінює permissions. Native profile має бути підтверджений installed schema/runtime canaries на абсолютні шляхи та symlinks.

**Alternatives considered**: danger-full-access, blanket approvals, checkout без read fence — rejected. Новий container agent stack не додається до перевірки native support.

**Boundary**: Якщо native isolation недоступна, feasibility failed. Можливий supported external isolation потребує окремого обґрунтованого plan amendment без нових оплат; цей план не видає його за реалізований.

## R6 — Separate local static panel

**Decision**: Другий frontend entry у web workspace; Node operational server із snapshot/SSE, без product Root/auth/Supabase та без running Vite.

**Evidence**: Design inventory/tokens є обов’язковими; Progress/Spinner уже в `components/ui/feedback.tsx`; cascade у `styles/index.css`. Конституція вимагає один owner subscription/reconnect і не дозволяє recurring client polling.

**Rationale**: Панель працює під час beta/product restart і не додає privileged routes у user agent. UI reuse без другого app/workspace.

**Alternatives considered**: Product auth route залежить від sign-in; native app додає packaging; polling дублює transport.

## R7 — Truthful progress and metrics

**Decision**: Incremental validated journal projection + separate ephemeral worker heartbeat; frozen applicable step weights; 100% тільки final acceptance.

**Evidence**: Journal event має `payload.stepId/durationMs`; metrics читає top-level fields, report використовує `snapshot.events ?? []`. Admission heartbeat — child lease, не executor observation. Existing fixed watcher опитує GitHub програмно без моделі.

**Rationale**: Потрібна normalization canonical events, а не другий truth store. Лог/heartbeat/таймер не доводять percent completion. Heartbeat fsync збільшує disk/log overhead без receipt value.

**Alternatives considered**: Fake time percent rejected; equal step count лише low-confidence fallback; reread full log per UI event не масштабується.

## R8 — Budgets, restart and owner boundary

**Decision**: Cause-level task budgets across SHA; pinned profile з numeric token/time caps; launchd user service після explicit install; start-marker/boot ownership before adoption.

**Rationale**: Новий SHA або інший текст не обнуляє ліміт. Detached process не є restart supervisor. Sleep/offline фізично зупиняють локальні дії; recovery SLA починається після login/доступності передумов. Token cap має in-flight overshoot, а missing accounting не є нулем.

**Owner boundary**: Потрібний доступ/MFA/new payment/unsupported scope/unauthorized after-publish successor. Прямі chat questions не скасовують task. Final report durable; доставка в origin chat тільки за supported adapter.

## Conclusion

Обрані рішення визначені, незаповнених архітектурних виборів немає. Runtime feasibility залишається явним G1 acceptance, не твердженням про готовність. No new paid infrastructure; усі canonical release gates збережені.
