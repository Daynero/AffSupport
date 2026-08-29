# Beta Staging Environment

A production-equivalent copy of Soty that runs entirely on your own machine, with its own database
and its own accounts, so a new feature is exercised end to end **before** it reaches production.

Beta is a testing surface, not a second product. It is never distributed, never appears in the update
channel, and never touches production data, production accounts, or production analytics. It is
reachable only on this machine's loopback interface.

|                     | Production   | Soty Dev                          | **Beta**                           |
| ------------------- | ------------ | --------------------------------- | ---------------------------------- |
| Agent port          | 43120        | 43130                             | **43140**                          |
| Web                 | hosted       | 5173                              | **5175**                           |
| Bundle id           | `com.wishly` | `com.wishly.dev`                  | **`com.wishly.beta`**              |
| Application Support | `Soty`       | `Soty Dev`                        | **`Soty Beta`**                    |
| Release channel     | `stable`     | `development`                     | **`beta`**                         |
| Authentication      | real         | **faked** (`VITE_LOCAL_DEV_AUTH`) | **real, against the local stack**  |
| Entitlement gate    | enforced     | not enforced                      | **enforced, with a beta-only key** |

Soty Dev and beta are different tools. Soty Dev is for _working on_ the app and fakes sign-in; beta
is for _verifying_ it and therefore must not.

## Prerequisites

| Requirement                                  | Why                                          | Install                                                                   |
| -------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Node 22 and installed workspace dependencies | Builds and scripts                           | `brew install node@22 && brew link --overwrite --force node@22`           |
| A running container runtime                  | `supabase start` needs a reachable daemon    | `brew install colima docker && colima start --cpu 4 --memory 8 --disk 60` |
| Supabase CLI                                 | Runs the local stack                         | Release binary from `github.com/supabase/cli` into `~/.local/bin`         |
| FFmpeg and FFprobe on `PATH`                 | Media tooling                                | `brew install ffmpeg`                                                     |
| Free ports 43140, 5175, 54321–54324          | Coexistence with production and ordinary dev | —                                                                         |

**Node 22, not newer.** Node 26 breaks jsdom — 56 of the UI tests fail with `localStorage` undefined.
Node 22 is also what the release workflow runs, so local and CI agree. The packaged app ships its own
Node 24 runtime and is unaffected either way.

**colima rather than Docker Desktop.** It installs entirely in userland through Homebrew, needs no
administrator password and no GUI, and hands the Supabase CLI an ordinary Docker socket. Start it once
per boot with `colima start`, or `brew services start colima` to bring it up at login.

`npm run beta:doctor` checks every one of these and reports **all** problems in a single pass with a
remedy for each, so a first run costs one fix cycle rather than several.

One-time setup:

```bash
cp .env.beta.example .env.beta          # then fill in the values the doctor names
node scripts/generate-signing-keys.mjs --beta
npm run beta:doctor
```

The beta entitlement keypair is deliberately separate from production: a production-issued token is
cryptographically invalid in beta and a beta-issued token is invalid in production, with no
configuration to get wrong. Copy the printed public key into `AGENT_ENTITLEMENT_PUBLIC_KEY` in
`.env.beta`, and the private key into `AGENT_TOKEN_PRIVATE_KEY` in `supabase/functions/.env.local`.

`.env.beta` is git-ignored. `.env.beta.example` is the only tracked half and contains placeholders
only — no beta endpoint, key, or switch value may live in a file that feeds a production build.

## Start

```bash
npm run beta:up
```

The doctor runs first and must pass, so nothing is started before the prerequisites and the isolation
guard are known good. On success the command prints the source revision the copy is running and how
far the `beta` line trails `main` — a stale beta produces false conclusions, so it says so rather than
letting you assume otherwise.

On macOS, `beta:up` starts an installed Colima instance automatically when Docker is not reachable.
It also mirrors the git-ignored `supabase/functions/.env.local` to the filename consumed by the local
Supabase edge runtime. A normal restart therefore needs only this one command; no Docker, Functions,
agent, or Vite preparation is manual.

**`beta:up` does not apply new migrations.** It brings the database back from a snapshot — its own
log says `Starting database from backup...` — so a migration added since that snapshot is simply not
there. Only `npm run beta:reset` replays the chain. This is easy to miss because the product does not
say "your schema is old": a missing function surfaces as whatever the calling screen shows for an
unexpected server error, which for the team lifecycle actions is the generic "something went wrong"
toast. **After pulling or writing a migration, reset before validating anything that depends on it.**

`beta:up` also proves the local edge runtime is actually serving before it reports beta up, and
restarts it once if it is not. `supabase start` exits 0 even when it has given up on a service that
failed its health check; when that service is the edge runtime, every server-side team feature —
Drive connect, Drive ops, library ops, invitations, catalog sync, entitlement — answers 503 while
beta still claims to be running, which makes the product look broken rather than unstarted.

- Web: <http://127.0.0.1:5175>
- Agent: <http://127.0.0.1:43140>
- Local Supabase Studio: <http://127.0.0.1:54323>
- Captured outbound mail: <http://127.0.0.1:54324>

## Flows exercisable in beta

| Flow                                                                                                              | Status in beta                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-up, sign-in, sessions, profile, account status                                                               | **Works out of the box.** Real authentication against the local stack; sign-in mail is captured by the local catcher, never delivered      |
| Pairing the local tool to the site                                                                                | **Works out of the box**                                                                                                                   |
| Entitlement issuance and the offline grace window                                                                 | **Works out of the box**, enforced with the beta key                                                                                       |
| All media tooling — compression, image embedding, transcription, landings                                         | **Works out of the box**                                                                                                                   |
| Team workspaces, members, roles                                                                                   | **Works out of the box**                                                                                                                   |
| Team invitations                                                                                                  | **Works, but nothing is sent.** The invitation link is returned and shown in the UI; copy it and open it yourself. See below               |
| External storage (Google Drive) and everything downstream of it — catalog sync, creative library, landing gallery | **Requires the optional opt-in below.** Until then these surfaces are visibly marked unavailable and never call the production integration |
| Production release, signing, notarization, update channel                                                         | **Not exercisable in beta**, by design                                                                                                     |

### Why invitations are not delivered

Most outbound messages travel through the platform's own transport and are captured by the local mail
catcher automatically. Invitations do not: `supabase/functions/team-invitations/email.ts` posts
directly to a third-party delivery API, which the local stack never sees. A beta environment with a
delivery credential configured would therefore send **real invitations to real people**.

So beta configures no delivery credential, the doctor fails with `BETA_DELIVERY_PROVIDER_FORBIDDEN`
if one appears, and the function does not even attempt a delivery request — it hands the invitation
link back instead, which keeps the flow fully exercisable offline.

### Optional: connecting external storage in beta

Beta is usable with no third-party account at all, so this is opt-in and only worth doing when you
actually need to verify Drive-dependent flows.

1. Create your own Google OAuth **test** client (Web application) in a project you control.
2. Add the redirect URI `http://127.0.0.1:54321/functions/v1/drive-oauth-callback` — it is already
   documented in `supabase/functions/.env.example`.
3. In `supabase/functions/.env.local` set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_REDIRECT_URI`, and `DRIVE_OAUTH_MODE=testing`. The client needs only the
   non-restricted `drive.file` scope (feature 011); a Testing-status consent screen expires
   refresh tokens after 7 days, which the chip surfaces as `needs_reauth`.
4. Enable the Google Picker API on the same project and set `VITE_GOOGLE_PICKER_API_KEY` and
   `VITE_GOOGLE_PROJECT_NUMBER` in `.env.beta`; without them the folder chooser cannot open.
5. Also enable the **Google Drive API** on that project — the Picker API alone is not enough,
   and without it every catalog call fails.
6. Recreate the stack with `npm run beta:down && npm run beta:up`. A plain `docker restart` will
   not do: the containers take their environment when they are created, not when they start.

Production must stay on `DRIVE_OAUTH_MODE=verified`; the release gate enforces that independently.

## Stop

```bash
npm run beta:down
```

Stops the agent and the web server — escalating from SIGTERM to SIGKILL if either will not go — then
stops the local stack, and exits non-zero naming anything that would not release. "It looked like it
stopped" is never the outcome.

## Reset

```bash
npm run beta:reset
```

Re-applies every migration (which exercises the migration chain as a side effect), seeds the
fixtures, and clears resettable state from the `Soty Beta` Application Support directory. Agent queue
state, previews, pairing, and entitlement are reset; downloaded models and runtimes under `models/`
and `runtime/` are preserved. Incomplete `.part` files are preserved too, and the downloader resumes
them with HTTP Range rather than restarting multi-gigabyte downloads.

On macOS those reusable assets live at:

```text
~/Library/Application Support/Soty Beta/models/
~/Library/Application Support/Soty Beta/runtime/
```

They are beta-only and never shared with production or Soty Dev.

The safety check runs **before** the first destructive step: a non-local database target fails with
`BETA_RESET_TARGET_UNSAFE` and nothing is touched. An unparseable target is treated as remote, not
assumed local.

The baseline after a reset:

| Fixture    | Value                                                                                  |
| ---------- | -------------------------------------------------------------------------------------- |
| Account    | `beta@soty.local` / `beta-password`, confirmed, `account_status = active`, plan `team` |
| Workspace  | "Beta Workspace", owned by that account, with it as admin                              |
| Pilot gate | that account is also in `public.admin_users`, which is what unlocks the workspace      |

The pilot gate is easy to overlook and total in its effect: `private.team_workspace_allowed`
unlocks a space only when one of its active members is also a product admin. Without that row the
fixture workspace exists but `list_my_teams` returns nothing and `can_access_team_workspace` is
false, so `/team` shows the "in development" gate and **no team flow is exercisable at all**. It is
the product's own allowlist applied to a local-only account, and it never reaches production.

Fixtures are applied explicitly rather than wired in as `config.toml`'s shared seed, so ordinary local
development keeps its own behaviour.

## Promotion

`beta` is a long-lived integration line. Feature work lands there first; production receives it only
by merge from `beta`, never by a direct commit that skips verification.

```
feature branch ──▶ beta ──▶ verify ──▶ merge into main ──▶ release
```

Recommended daily flow:

1. Develop and review on a feature/fix branch.
2. Merge the accepted branch into `beta` and push `beta`.
3. Check out `beta`, run `npm run beta:up`, and test the source beta.
4. Run `npm run beta:package` and `npm run beta:verify` for the exact clean commit.
5. Only after verification, merge that `beta` commit into `main`; production gates reject an
   unverified or different revision.

Branch merging stays explicit. `beta:up` never switches branches, merges code, commits changes, or
pushes on its own, so starting a test environment cannot rewrite source history.

Before promoting, verify on the **packaged** build, not just from source. Run-from-source misses a
whole class of bugs — bundled tool resolution, packaged-mode paths, entitlement gating, update checks
— that only appear once the app is packaged:

```bash
npm run beta:package
npm run beta:verify        # writes release/beta/verification.json on success only
```

Then promote and release as usual:

```bash
git checkout main && git merge beta
npm run release:check
npm run package:mac        # or npm run deploy:web
```

### What each gate rejects

| Gate                           | Refuses                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify-release.mjs`           | A beta release channel, version, or build id (`RELEASE_BETA_IDENTITY`); any beta marker in a production-feeding file or in the built web bundle (`RELEASE_BETA_CONFIG`) |
| `verify-beta-promotion.mjs`    | A commit not contained in `beta`; a missing verification record; a record for a different revision; a record built from a dirty worktree (`RELEASE_BETA_UNVERIFIED`)    |
| `verify-published-release.mjs` | A beta identity anywhere in the published update channel                                                                                                                |
| `package-beta-mac.sh`          | Its own run, if it would modify `release.ts`, `stable.json`, `config/production.env`, `packaging/`, `supabase/migrations/`, or any git tag                              |

The promotion gate prints the divergence between `main` and `beta` before returning a verdict, so a
decision that needs you is visible before anything is published.

`supabase/config.toml` is deliberately **exempt** from the beta-marker scan. It allowlists the beta
loopback redirect URLs that real sign-in against the local stack needs, it is read only by a
locally-run stack, and it never travels into a production artifact. Scanning it would fail every
release for a setting that cannot reach production.

## Troubleshooting

Every failure names a machine code and a remedy. The common ones:

| Code                               | What happened                                                                      | Fix                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `BETA_ENV_MISSING`                 | `.env.beta` is absent, or a required key is unset or is not `beta`                 | `cp .env.beta.example .env.beta` and fill in what the doctor names                                                                  |
| `BETA_PREREQUISITE_MISSING`        | The container runtime, Supabase CLI, FFmpeg, FFprobe, or whisper-cli was not found | Install the named tool. On macOS `beta:up` starts existing Colima automatically and `brew install whisper-cpp` provides whisper-cli |
| `BETA_PORT_IN_USE`                 | 43140, 5175, or a local-stack port is held                                         | `npm run beta:down`; if that is not enough, find the holder with `lsof -tiTCP:<port> -sTCP:LISTEN`                                  |
| `BETA_PRODUCTION_ENDPOINT`         | A URL or key in the beta profile points off this machine                           | Point it at `127.0.0.1`. If it is the entitlement key, run `node scripts/generate-signing-keys.mjs --beta`                          |
| `BETA_LOCAL_AUTH_FORBIDDEN`        | `VITE_LOCAL_DEV_AUTH=true`                                                         | Set it to `false`. Beta exists to exercise real authentication; that flag is a Soty Dev setting                                     |
| `BETA_DELIVERY_PROVIDER_FORBIDDEN` | A delivery credential is configured                                                | Leave `RESEND_API_KEY` and `INVITE_EMAIL_FROM` empty; invitations are surfaced locally instead                                      |
| `BETA_RESET_TARGET_UNSAFE`         | The reset target is not local                                                      | Unset `SUPABASE_DB_URL`, or point it at `127.0.0.1`                                                                                 |
| `RELEASE_BETA_IDENTITY`            | A beta artifact or channel reached the release path                                | Release from `main`, not from a beta build                                                                                          |
| `RELEASE_BETA_CONFIG`              | A beta value is in a production-feeding file or the built bundle                   | Remove it; beta config belongs only in the git-ignored `.env.beta`                                                                  |
| `RELEASE_BETA_UNVERIFIED`          | The commit is not in `beta`, or has no matching verification record                | Merge to `beta`, run `npm run beta:package && npm run beta:verify`, then promote                                                    |

**Sign-in redirects fail.** The local stack allowlists redirect URLs from `supabase/config.toml`
only. If you changed the beta ports, add the new origins there and restart the stack.

**The invitation "was not sent".** That is correct — see _Why invitations are not delivered_. Copy
the link from the UI and open it yourself.

**A feature works in beta from source but breaks in the packaged build.** That is exactly what the
packaged build exists to catch: bundled tool resolution, packaged-mode paths, entitlement gating, and
update checks all behave differently. Fix it before promoting rather than after.

## Measured timings

Recorded from a real run so the success criteria have evidence rather than an assumption.

| Step                               | Target       | Measured                       |
| ---------------------------------- | ------------ | ------------------------------ |
| First bring-up on a clean checkout | under 15 min | _not yet measured — see below_ |
| Subsequent bring-up                | under 5 min  | _not yet measured_             |
| Reset to fixture-seeded baseline   | under 5 min  | _not yet measured_             |

These require a machine with the container runtime, Supabase CLI, and FFmpeg installed. Fill them in
on the first real run — `npm run beta:doctor` names anything still missing.
