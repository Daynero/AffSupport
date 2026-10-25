> Historical full-scope design, deferred by the owner’s 3–4h MVP decision. Active requirements: [spec.md](../spec.md). This artifact does not expand the current implementation scope.

# Proposed governance amendment: mini admission

**Status**: PROPOSED, не ратифіковано. Цей файл — design artifact; чинна constitution 3.0.1, AGENTS і runbooks не змінюються в analyze. Планування/реалізація не є дозволом на production.

## Separate amendment obligation

Implementation готує окремий явний amendment до `.specify/memory/constitution.md` за її governance procedure: proposed 3.1.0, Sync Impact Report, maintainer review/merge ratification. До цього executable production mini mode closed. Full packaging/final-manifest flow, single source release identity та усі чинні G0/042 obligations зберігаються.

## Proposed normative addition to Principle II and release gating

> A separately scoped mini release MAY deploy an exact verified web/backend candidate without rebuilding agent installers only when the signed agent update channel, all agent artifact identities, and required agent contracts remain unchanged. Agent independence MUST be proven against the published agent input baseline, including shared, generated, dependency and configuration inputs. Unknown impact MUST block mini admission. The exact clean candidate MUST have fresh runtime evidence on an unchanged, provenance-verified packaged agent with real authentication and entitlement; a previous candidate's beta record MUST NOT be relabelled. Shared changes MAY be admitted only through a versioned, verified agent-independence proof. Compatible database/server changes MUST preserve existing clients and data at every rollout/recovery stage, with isolated upgrade, role and bounded execution proof. These exceptions apply only to mini admission and MUST NOT weaken full-release packaging or final signed-manifest gates.

## Ratification and acceptance predicate

Production activation requires: committed ratified amendment SHA included in trusted runner lineage; expected policy digest; exact installed runner/verifier input digest; at least three live sandbox mini runs covering web-only, backend/DB transition and interruption/recovery; verified external identities/control results; no dry-run/adapter override adoption. Relevant 24-case policy suite, native cohort evidence та timing acceptance мають окремі references. Existing full activation plus G0 and 042 production readiness still required; string-version grep або unrelated old runs не substitution.

Test harness може виконувати unit/disposable/sandbox verification без production activation. Hosted sandbox writes потребують окремої чинної авторизації цілі; жодного автоматичного створення платних ресурсів. Якщо середовище недоступне, evidence NOT_RUN/BLOCKED; planning не повинен просити production exception.

## Documents to synchronize at implementation

Constitution + Sync Impact Report; `AGENTS.md` (release/beta/verification sections only), `docs/PRODUCTION.md`, `docs/BETA.md`, `docs/ANALYTICS_CLI.md`, `config/environments.json` (dedicated secret metadata), canonical runner/verification contracts. `CLAUDE.md` залишається pointer на AGENTS, без дублювання subject rules. Нова необов'язкова CLI поверхня не дозволяє обхід через existing deploy/backend/rollback entrypoints.
