# Contract: Beta Environment Variables

**Status**: Design · **Feature**: [../spec.md](../spec.md) · **Model**: [../data-model.md](../data-model.md)

Defines the environment surface a beta copy is configured through, and the precedence rules that
decide which value wins. This is the contract every beta script and both applications read; nothing
may re-derive a beta port, name, or origin locally.

## Precedence

For each variable, first match wins:

1. An explicit value in the process environment (used by the packaging script and by CI-less
   one-off overrides).
2. The value in `.env.beta` at the repository root.
3. The declared default in `packages/shared/src/environment.ts`.

`VITE_*` variables reach the web bundle at build time through Vite's `--mode beta` load of
`.env.beta` from the repository root (`envDir` is already `../..`). Non-`VITE_` variables are read by
the agent process and the scripts at run time.

## Web build variables

| Variable | Required | Value in beta | Guard |
|---|---|---|---|
| `VITE_APP_ENVIRONMENT` | yes | `beta` | Anything other than `production`/`beta` fails parsing; absent means `production` |
| `VITE_SUPABASE_URL` | yes | local stack API, loopback | Non-loopback → `BETA_PRODUCTION_ENDPOINT` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | yes | local anon key | Secret/service_role key → rejected by the existing browser-key check |
| `VITE_SITE_URL` | yes | `http://127.0.0.1:5175` | Non-loopback or equal to `PRODUCTION_SITE_ORIGIN` → `BETA_PRODUCTION_ENDPOINT` |
| `VITE_AGENT_URL` | yes | `http://127.0.0.1:43140` | Must match the beta agent port |
| `VITE_ANALYTICS_ENABLED` | yes | `false` | Suppression is also structural; a `true` value here is a configuration error, not an escape hatch |
| `VITE_LOCAL_DEV_AUTH` | yes | `false` | `true` → `BETA_LOCAL_AUTH_FORBIDDEN` |
| `VITE_TEAM_DIRECT_ADD_MODE` | no | `disabled` \| `testing` | Existing validation unchanged |

## Agent process variables

| Variable | Required | Value in beta | Guard |
|---|---|---|---|
| `SOTY_ENVIRONMENT` | yes | `beta` | Same parser as the web value |
| `AGENT_PORT` | yes | `43140` | Existing 1024–65535 check; must not equal 43120 or 43130 |
| `PUBLIC_SITE_ORIGIN` | yes | loopback beta origin | Existing `validOrigin` already permits `127.0.0.1`; beta additionally rejects any non-loopback value |
| `DEV_SITE_ORIGIN` | yes | `http://127.0.0.1:5175` | Feeds the CORS/SSE origin allowlist |
| `AGENT_SUPPORT_DIRECTORY_NAME` | yes | `Soty Beta` | Already honoured by `applicationSupportRoot()` |
| `AGENT_ENTITLEMENT_PUBLIC_KEY` | yes | beta public key | Must differ from the production key; empty → gate unenforced → rejected in beta |

## Local Supabase function variables

Written to the already-gitignored `supabase/functions/.env.local`.

| Variable | Value in beta | Note |
|---|---|---|
| `AGENT_TOKEN_PRIVATE_KEY` | beta entitlement private key | Pairs with the agent's beta public key |
| `WISHLY_SITE_URL` | `http://127.0.0.1:5175` | Feeds the function CORS allowlist |
| `DRIVE_OAUTH_MODE` | `disabled` by default, `testing` after opt-in | Fails closed (research R10) |
| `RESEND_API_KEY` | **empty** | A delivery-provider credential is forbidden in beta; a set value fails with `BETA_DELIVERY_PROVIDER_FORBIDDEN` |
| `INVITE_EMAIL_FROM` | **empty** | Same rule; with no provider configured, the invitation flow returns the link for local display instead of sending |

## Compatibility

Additive only. Absent `VITE_APP_ENVIRONMENT` / `SOTY_ENVIRONMENT` yields `production`, so existing
production builds, the Soty Dev package, and every current script behave exactly as before without
modification.
