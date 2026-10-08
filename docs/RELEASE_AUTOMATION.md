# Local release controller

The controller starts the existing canonical runner, observes its hash-chained
journal, and invokes a managed-auth Codex repair only after a failed worker has
stopped. It does not replace [PRODUCTION.md](PRODUCTION.md), authorize a release,
or make sandbox destinations interchangeable with production.

## What runs where

- macOS packaging, beta checks and signing stay on the maintainer Mac, one heavy
  operation at a time under existing resource admission and `nice -n 15`.
- Windows remains on the existing GitHub Actions workflow. The panel links to
  the correlated run; it does not invent a native percentage.
- A small persistent Node controller and loopback panel show progress. Closing
  the browser or chat does not cancel the task. Observation, SSE, heartbeat and
  delivery/result reconciliation do not invoke a model.
- Repair uses the installed Codex CLI and existing managed ChatGPT account.
  No API-key fallback, new paid service, credential copying, or agent networking.
  Existing subscription quota and GitHub runner availability still apply.

## Installation is explicit

Prerequisites: Node 22.12–24, repository dependencies, the existing runner's
probe/portable inputs/beta setup, authenticated `gh`, and Codex CLI **0.161.0**
with managed ChatGPT login. A CLI upgrade invalidates provider readiness until
the actual canaries are repeated. Do not print or copy auth files.

```bash
npm run release:install
nice -n 15 npm run release:panel:build
npm run release:provider:verify -- /absolute/path/to/codex
```

The provider verification starts a real model against synthetic fixture data.
Its JSON names the retained fixture containing `capability.json`; it is **not**
part of `npm run verify`, and does consume existing model quota. The test proves
allowed nonce reading, a real patch, denied secret/symlink/original-checkout and
network access, live usage, and interruption. Only a `ready: true` receipt is
accepted. Readiness is bound to SHA-256 of the exact provider-boundary code;
changing isolation code invalidates it. The agent cannot read .git/history to
bypass secret-path restrictions. The real CLI supplies the evidence.

Supply an existing validated target-bindings JSON and the actual receipt:

```bash
npm run release:controller:install -- --codex /absolute/path/to/codex --provider-receipt /absolute/path/to/capability.json --bindings /absolute/path/to/bindings.json
npm run release:controller -- doctor
```

Installation creates the current user's `com.soty.release-controller` launchd
service, not a system service. It refuses to overwrite an existing plist.
Runtime configuration, the Unix control socket, records, repair checkouts and
the panel build live under ignored `release/automation/`. The socket/records
are private to the user. `serve` runs in the foreground for troubleshooting:

```bash
npm run release:controller -- serve
```

Do not start foreground and installed services together. The ownership lock
rejects a second controller. Nothing is accepted merely by installing it.

## Start and observe an explicitly authorized release

Prepare the exact version/SHA and canonical release intent as required by the
runbook. The controller rejects `bump`: the source version must already be frozen.
It validates the repository and target binding, and allows only one live task.
Sandbox starts receive their isolated binding explicitly; production is pinned.

```bash
npm run release:controller -- accept --intent /absolute/path/to/intent.json
npm run release:controller -- panel TASK_UUID
npm run release:controller -- status TASK_UUID
npm run release:controller -- report TASK_UUID
npm run release:controller -- cancel TASK_UUID
npm run release:controller -- decide TASK_UUID retry
```

`accept` returns a durable task UUID distinct from its candidate run UUID.
`panel` prints a single-use, 60-second bootstrap URL. Open that URL in Chrome.
The fragment is exchanged for an HttpOnly, SameSite session and removed from the
address bar. The browser then owns one EventSource subscription; reconnecting
or opening another tab never starts a release or repair. A controller restart
requires a fresh panel URL. The server binds **127.0.0.1:43150**, rejects foreign
Host/Origin requests, and requires CSRF plus an expected revision for cancellation.
Do not expose it through a tunnel or bind it publicly.

The percentage is confirmed weighted gate completion, not elapsed time. Until
canonical `run_completed` plus the final live verification are proved it is
capped at 99%. Unknown usage remains “unknown”, never zero. Old worker heartbeat
and browser disconnection are distinct from failure. Source repair creates a
new run/SHA, invalidates exact-SHA evidence and visibly explains any progress
regression. Logs are bounded, redacted and escaped, obtained through opaque refs.

## Automatic repair and safety boundaries

Defaults in `config/release-automation-policy.json`: 3 attempts per cause,
6 per task, 80,000 tokens/20 minutes per attempt, 300,000 tokens/90 active minutes
per task. Candidate replacement never resets these counters. Usage updates are
cumulative and deduplicated. Model interruption limits overshoot; a hard exact
token ceiling is not claimed. Pre-execution provider outages back off from
30 seconds to 5 minutes for at most 30 minutes, without starting model turns.

The agent edits a standalone checkout, not the user's worktree/index. It can
read bounded individual files and apply patches. Shell programs, builds, tests,
network and additional permission requests are denied. Heavy canonical gates
run independently after the provider is closed. Automatic import permits only
product source beneath `apps/` and `packages/`; tests, scripts, governance,
workflow/config files, package metadata, credentials and release artifacts are
outside automatic repair scope. Such a fix needs an explicit owner decision.
This prevents a repair from weakening the gate that evaluates it.

Before publication, an accepted source patch becomes a new candidate commit
and goes through the canonical beta fast-forward/lease and all gates again.
After a publication-affecting step has started, source changes are blocked:
no tag movement, asset replacement or silent rebuild. Cancellation fences new
repairs/steps; an already-started external action must finish or be reconciled.

Recovery adopts known workers by PID **and** process-start/boot identity.
Completed, persisted repair results can be applied without another model call.
Persisted provider state is queried without restarting a turn. Lost acceptance,
missing terminal usage, or a crash during candidate application remains an
explicit ambiguity blocker; it is never guessed away or duplicated. `retry`
cannot bypass ambiguity or unknown usage, skip gates or reset budgets. A budget
retry requires an explicitly changed, validated policy with sufficient limits.

## Production activation and remaining acceptance

Production additionally requires a local `activation.json` containing
`schemaVersion: 1`, the actual G0 `governanceSha`, and at least three distinct
`sandboxRunIds`. The controller checks the constitution commit ancestry and
each real sandbox snapshot/hash-chain for live execution without adapter
overrides, final live verification and run completion. Never fabricate those
records or substitute dry-run/unit-test evidence.

Implementation unit/integration checks and a provider smoke are not proof of
three complete unattended releases. Real isolated sandbox runs, installer/login
and wake recovery, weak-machine CPU/RSS measurements, and Chrome visual QA must
be recorded before calling this production-ready. See
[feature evidence](../specs/029-autonomous-release-panel/implementation.md).
No production release or launchd installation was performed while implementing.

Uninstall only this service; retained records and artifacts remain:

```bash
npm run release:controller:install -- --uninstall
```
