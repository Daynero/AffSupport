# Quickstart validation: Autonomous local release

**Status**: Commands implemented; live acceptance remains pending. Follow [the operational guide](../../docs/RELEASE_AUTOMATION.md). This file does not authorize production.

## Prerequisites

Maintainer Mac, Node 22, workspace dependencies, чинний runner probe/portable inputs/beta tooling, authenticated `gh`, Codex CLI with managed ChatGPT login. Production keys залишаються в дозволеному локальному сховищі. Agent model quota available; no API-key fallback. Sandbox bindings must target isolated destinations; no production intent in fixtures.

## 1. Provider feasibility first

Наявні read-only команди, виконані при плануванні:

```bash
npm run release:provider:verify -- /absolute/path/to/codex
```

Pinned CLI: 0.161.0, managed ChatGPT auth. The actual synthetic smoke consumes existing model quota and writes capability.json in its retained fixture. Never print/copy auth files; only ready:true evidence is accepted.

The smoke proves native nonce reading, patching, interruption, live usage and secret/symlink/original-checkout/network denial. Chat-close repair, full canonical validation and recovery acceptance remain separate live scenarios. Failure is a capability blocker, never a paid API fallback.

## 2. Focused tests

```bash
npx vitest run tests/release-controller.test.ts tests/release-controller-handoff.test.ts tests/release-repair-provider.test.ts tests/release-repair-budget.test.ts tests/release-repair-dispatch.test.ts
npx vitest run tests/release-panel.test.ts tests/release-panel-server.test.ts tests/release-panel-ui.test.tsx
```

Unit/integration fixtures do not invoke models or production. The provider smoke is explicit and separate, not hidden in npm verify. Socket tests require normal localhost permissions.

## 3. Explicit installation and doctor

```bash
npm run release:install
nice -n 15 npm run release:panel:build
npm run release:controller:install -- --codex /absolute/path/to/codex --provider-receipt /absolute/path/to/capability.json --bindings /absolute/path/to/bindings.json
npm run release:controller -- doctor
```

Install explicitly registers a user launchd service and refuses to overwrite an existing plist. Doctor does not start a model. Paths must refer to actual validated inputs. No system sleep changes.

Doctor healthy означає components/config/capability available; не production permission. Actual auth refresh/quota failures preserve explicit blocker.

## 4. Accept isolated task and view panel

```bash
npm run release:controller -- accept --intent /absolute/path/to/validated-sandbox-intent.json
npm run release:controller -- status <task-id>
npm run release:controller -- panel <task-id>
```

Temporary directory must be actually created by harness; placeholder files are not instructions to fabricate acceptance. Harness proves all bindings nonproduction. Expected: accepted task ID; independent window shows version/estimated percent/current step, freshness, next action. Closing window doesn't stop task. Additional tabs don't add remote watchers.

Policy comes from validated tracked config, not a per-intent --policy override. CLI already returns JSON. For UI-only testing, `node tests/fixtures/release-panel-demo.mjs` starts an explicitly labelled DEMO without runner/model/external actions; synthetic progress is never acceptance evidence.

## 5. Acceptance matrix

| Scenario                                  | Required outcome                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| Three clean full sandbox runs             | 0 manual actions after request; all final proofs; 100% only at end                |
| 5 vs 60 min unchanged remote wait         | 0 added model calls/context bytes                                                 |
| Controlled transient network failure      | Bounded nonmodel retry, unchanged receipt identity                                |
| Fixture build/config failure              | Automatically accepted repair≤60 с p95; independent gate succeeds; no owner click |
| Provider delivery/accept/result loss      | Query/adopt, one editor; ambiguous result blocks duplicate turn                   |
| Same cause across three candidates        | Third failed repair→one blocker; no reset by SHA/text                             |
| New source before publication             | New run ID/SHA, invalid proofs removed, visible progress regression reason        |
| Source change after partial publication   | No replacement/tag move; authorized successor or owner blocker                    |
| Manifest-only commit                      | New exact-SHA beta, no rebuilt published binaries                                 |
| Controller crash, close-chat repair, wake | Ownership reconcile/adoption, no duplicate external effects                       |
| Live controller but dead/stuck worker     | Freshness distinct from progress; no false healthy completion                     |
| Cancel during repair/publish              | Fence rejects late result; reconcile external effect before stop                  |
| Cross-origin/token/log traversal canaries | 0 privileged effects/secrets leaked                                               |
| Read/network canaries in agent tools      | Secret paths/symlink escapes/exfiltration denied                                  |
| Unknown usage or depleted quota           | Explicit unavailable/unknown state, no paid API or fabricated zero                |

## 6. Verification, overhead and report

```bash
npm run verify
npm run verify:release
npm run release:controller -- report <task-id>
```

Measure helper/controller/panel CPU/RSS over 30 minutes on recorded Mac, separate browser baseline/agent/build processes. Acceptance ≤1% aggregate CPU and≤200 MiB additional RSS. Measure state display latency, 10/30-second heartbeat behavior, recovery within 60 с after login/prerequisites available. Report contains actual usage or unknown, active/wait/repair durations and immutable artifacts/evidence refs.

Existing G0 ratification and real release sandbox acceptance remain mandatory. Completion of these feature tests не дозволяє production автоматично. Production execution requires separate explicit validated intent under `docs/PRODUCTION.md`.

## 7. Handoff

See [tasks.md](./tasks.md) and [implementation evidence](./implementation.md). Missing live acceptance remains missing. Source repair is restricted to product source, never gate/governance/config/test rewrites. Unknown final usage and ambiguous application stop safely rather than duplicating an editor.
