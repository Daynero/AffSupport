# Contract: Beta CLI Surface

**Status**: Design · **Feature**: [../spec.md](../spec.md)

The npm script surface a maintainer uses. Follows the repository's existing script conventions:
`.mjs` for anything reading the shared contract, a `fail()` writing to stderr and exiting 1, and a
human confirmation line on success.

Every script that reads the shared contract runs `npm run build -w @video-compressor/shared` first,
per Constitution Principle II.

## Commands

| Command | Purpose | Success | Failure |
|---|---|---|---|
| `npm run beta:doctor` | Check prerequisites and profile isolation without starting anything | Exit 0, one line per satisfied prerequisite plus how far `beta` is behind `main` | Exit 1, one line per problem with its machine code and a remedy |
| `npm run beta:up` | Bring the whole beta environment up (FR-009) | Exit 0 once the web, agent, and local stack are reachable; prints the beta URL | Exit 1 with the first failing prerequisite; nothing left half-started |
| `npm run beta:down` | Stop everything cleanly (FR-012) | Exit 0, no orphaned children, ports released | Exit 1 naming what would not stop |
| `npm run beta:reset` | Return to the clean baseline and seed fixtures (FR-024–FR-026) | Exit 0, prints what was reset and which fixtures were seeded | Exit 1; `BETA_RESET_TARGET_UNSAFE` if the target is not loopback |
| `npm run beta:package` | Build the packaged beta app (FR-002a) | Exit 0, prints the artifact path and beta build id | Exit 1 if it would touch `release.ts`, `stable.json`, `config/production.env`, or any git tag |
| `npm run beta:verify` | Run the packaged-beta smoke and write the verification record (FR-002b) | Exit 0, writes `release/beta/verification.json` | Exit 1; no record written on failure |

## Behavioural rules

- **`beta:doctor` runs first inside `beta:up`.** Bring-up never starts a component before the
  prerequisites are known good, so a missing container runtime produces a named message rather than a
  half-started environment (FR-010).
- **Prerequisites are reported in full, not one at a time.** A first run with three things missing
  lists all three, so the maintainer fixes them in one pass rather than three cycles.
- **Every failure names a remedy.** `BETA_PREREQUISITE_MISSING` prints what to install or start, not
  just what was absent.
- **Child processes are spawned with `shell: false` and argument arrays**, tracked by PID, and shut
  down SIGTERM → SIGKILL with `.unref()`'d timers (Constitution Principle IV).
- **`beta:reset` refuses non-loopback targets before doing anything destructive** — the check
  precedes the first write, so a misconfigured profile cannot cause partial damage.
- **`beta:package` is forbidden from production side effects.** It asserts the production-identity
  files are unmodified before and after the build, matching the constitution's rule that dev builds
  must not touch production versions, the stable manifest, git tags, migrations, or Cloudflare.

## Chaining into the existing release path

`verify-beta-promotion.mjs` joins the established chain rather than replacing any link:

```
deploy:web   → verify-web-env → verify:team-production → build:web
             → verify-release --deploy → verify-beta-promotion
             → verify-published-release → wrangler pages deploy
package:mac  → build → verify-release --package → verify:team-production
             → verify-beta-promotion → package-mac.sh
```
