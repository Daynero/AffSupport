# Handoff: ship Google brand verification (feature 025)

You are taking over a finished code change and doing everything that happens outside the
repository: Google Cloud Console, Search Console, Cloudflare DNS, production web and Edge
Function deploys, production checks, and the verification submission. Reply to the owner in
Ukrainian; write files in English.

Read first: `docs/GOOGLE_OAUTH_VERIFICATION.md` (the owner-facing checklist this handoff
executes), `AGENTS.md`, `docs/PRODUCTION.md` ("Серверні зміни релізу"). Memories that apply:
weak machine (one heavy process, `uptime` first, never `npm run verify`), concurrent sessions
(check `ListAgents` before touching the shared checkout), Cloudflare deploy poisons the module
cache, secret writes are blocked for agents, never `db reset` on a running stack.

## Goal

Google shows **Soty** with its logo on the consent screen, and the OAuth app is brand-verified
**for free**. Soty's scopes are `openid`, `userinfo.email`, `userinfo.profile`, `drive.file`,
all non-sensitive, so only brand verification applies. The owner has no budget: never add a
restricted Drive scope (`drive`, `drive.readonly`, `drive.metadata*`), which would require a
paid CASA assessment.

## What is already done (do not redo)

| Branch                               | Base                                            | Use                                                                               |
| ------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `025-google-brand-verification-prod` | `origin/beta` 4eda1c1 = **live production web** | Deploy from this                                                                  |
| `025-google-brand-verification`      | `origin/beta-dev`                               | Same change for the dev line; merge into `beta-dev` after production is confirmed |

A worktree with the prod branch checked out and `node_modules` installed is at
`/Users/daynero/RiderProjects/AffSupport-google` (switch it to the prod branch if needed).

The change:

- **Why:** Google brand verification requires every domain in the OAuth client to be verified
  in Search Console by the owner. Both OAuth returns went to `yvvvignywfmbdgkcxtfk.supabase.co`,
  which is on the Public Suffix List and can never be verified by us.
- **Sign-in** now returns to `https://soty.pp.ua/auth/callback`. New function
  `supabase/functions/google-sign-in` (verify_jwt = false) does the PKCE code exchange with the
  Edge `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and returns only the ID token; the browser
  calls `signInWithIdToken`. The function answers `mode: 'legacy'` (browser falls back to the
  old Supabase redirect) when the Edge client ID differs from the client Supabase's Google
  provider uses (`client_mismatch`), when that lookup fails (`provider_unreachable`), or when
  it is not configured (`not_configured`). A missing function also falls back.
- **Drive** returns to `https://soty.pp.ua/oauth/drive/callback`, a web page that forwards the
  query unchanged to `drive-oauth-callback`. `_shared/google-redirect.ts` forces this on
  production (site origin = `PRODUCTION_SITE_ORIGIN`) regardless of `GOOGLE_REDIRECT_URI`, so no
  secret has to change. Readiness now reports `redirectUri`.
- Homepage note about Drive + link to `/privacy#google-drive`; Privacy text updated (drive.file,
  link sharing, no AI training, date); in-product notice on the Drive connect step;
  `privacy.html`/`terms.html` generated at build with `<noscript>` HTML; `robots.txt`;
  homepage scrolls when it does not fit (the Privacy link was unreachable at 1280×720 and on
  phones); wordmark fits a phone.
- Logo for the console: `docs/google-oauth/soty-logo-120.png` (120×120).
- Verified: web tsc and test typecheck clean, eslint/prettier clean, 196 focused tests pass,
  `google-sign-in` booted in the real edge-runtime image and returned a correct `direct` URL
  against production Supabase. Not verified live: the whole sign-in round trip (needs the
  console step), the Drive connect notice on screen.

## Hold: no production deploys until the owner says so

**2026-09-17, owner:** do not deploy anything to production (web or functions) now. The owner is
making other changes in parallel and will ship everything in one release. Do the console-side
steps that change nothing for users (1, 2, and reading the client list), then stop and report.
Steps 3–9 wait for an explicit go-ahead from the owner in chat; each production deploy needs its
own "так".

## The order is the safety mechanism

Once `drive-connect` is deployed, every new Drive connection and reconnect sends Google
`redirect_uri=https://soty.pp.ua/oauth/drive/callback`; once `google-sign-in` is deployed and
the clients match, every sign-in sends `https://soty.pp.ua/auth/callback`. If Google does not
know those URIs yet, people land on Google's `redirect_uri_mismatch` page. So:

**console URIs → web → functions → checks → remove old URIs → branding → submit.**

Never reverse steps 2–4. Never remove the `supabase.co` redirect URIs before step 5 passes.

## Steps

Each console/DNS action changes the owner's account settings: say exactly what you will
change and get a "так" from the owner in chat before each one (or ask the owner to do it and
wait). Do not type passwords; the owner signs in.

### 1. Search Console — verify `soty.pp.ua`

- Google Search Console → Add property → **Domain** → `soty.pp.ua`, signed in as a Google account
  that is Owner or Editor of the production Cloud project (the one holding client
  `588652264319-…`).
- Add the TXT record it gives to the `soty.pp.ua` zone in Cloudflare DNS (`pp.ua` is itself a
  public suffix, so `soty.pp.ua` is the registrable domain; the TXT goes at the zone apex).
- Click Verify; DNS can take minutes.

### 2. Google Auth Platform → Clients → web client `588652264319-…`

Add, remove nothing:

- Authorized JavaScript origins: `https://soty.pp.ua`
- Authorized redirect URIs: `https://soty.pp.ua/auth/callback`, `https://soty.pp.ua/oauth/drive/callback`

While there, note (do not change) every other client in the project and its redirect URIs, and
whether the Drive functions' client is the same one. If the project has a separate client for
Drive, add `https://soty.pp.ua/oauth/drive/callback` to that one too.

### 3. Deploy the web from `025-google-brand-verification-prod`

- The shared checkout `/Users/daynero/RiderProjects/AffSupport` is used by other sessions and
  holds the deploy history (`release/automation/web-deployments.jsonl`) and the gitignored
  `apps/web/.env.production.local` (Picker key/project number — a build without it breaks the
  Drive folder chooser in production). Run `ListAgents`; if a peer is working there, message it
  and agree who deploys and when. Previous production web deploys (0bcc793, 4eda1c1) were made
  from that checkout with `npm run deploy:web`.
- `uptime` first. Then `nice -n 15 npm run deploy:web` from a checkout on the prod branch that
  has `apps/web/.env.production.local`. If a gate refuses, read why; do not bypass it.
- After deploy, in a clean browser tab:
  - `https://soty.pp.ua/` shows the Drive note under "Відкрити Soty"; the footer links are
    reachable by scrolling on a short window.
  - `https://soty.pp.ua/privacy#google-drive` lands on "Spaces on Google Drive".
  - `curl -s https://soty.pp.ua/privacy | grep -c noscript` → 1; `curl -s https://soty.pp.ua/robots.txt`
    → `User-agent: *` (not HTML).
  - If a page errors with a missing module, see the Cloudflare cache-poisoning memory before
    redeploying.

### 4. Deploy the three functions

Only `google-sign-in` (new), `drive-connect`, `drive-oauth-callback` change. Use the backend plan
tooling, not hand-typed deploys:

```bash
node scripts/plan-backend-release.mjs --since=4eda1c1 --out=release/automation/backend-plan-025.json
# The plan must contain exactly those three functions and no migrations.
# If it lists anything else, stop and tell the owner — something else is pending.
node scripts/apply-backend-plan.mjs --plan=release/automation/backend-plan-025.json            # dry run
node scripts/apply-backend-plan.mjs --plan=release/automation/backend-plan-025.json --confirm  # apply
```

`google-sign-in` must deploy with JWT verification off (`supabase/config.toml` declares
`[functions.google-sign-in] verify_jwt = false`). Confirm afterwards: an OPTIONS request with
`Origin: https://soty.pp.ua` to `https://yvvvignywfmbdgkcxtfk.supabase.co/functions/v1/google-sign-in`
answers 204, not 401.

### 5. Checks on production

Run in a `soty.pp.ua` tab (Chrome tools, JavaScript):

```js
// Which sign-in path the function chose — no state is stored server-side.
const r = await fetch('https://yvvvignywfmbdgkcxtfk.supabase.co/functions/v1/google-sign-in', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    action: 'start',
    codeChallenge: 'a'.repeat(43),
    nonceHash: 'f'.repeat(64),
    state: 'S'.repeat(43)
  })
});
const j = await r.json();
JSON.stringify(
  j.value.mode === 'direct'
    ? {
        mode: 'direct',
        redirect: new URL(j.value.authorizationUrl).searchParams.get('redirect_uri')
      }
    : j.value
);
```

- `direct` with `redirect: https://soty.pp.ua/auth/callback` → good. Ask the owner to sign out
  and sign in with Google once; the Google screen must come back to `soty.pp.ua/auth/callback`
  and land signed in. Check the account is the same (same spaces), not a new empty account.
- `legacy` / `client_mismatch` → the Edge `GOOGLE_CLIENT_ID` is not Supabase's client. Sign-in
  still works the old way. Tell the owner; the fix is to make them the same client (owner sets
  the Edge secrets `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to Supabase's client, or adds the
  Drive client ID to Supabase → Auth → Google → Client IDs — the latter does not switch the
  function to `direct`, so prefer the former). Agents cannot write secrets; give the owner the
  exact command. Do not continue to step 6 until `direct`.
- Readiness, signed in (Chrome, soty.pp.ua tab):
  `fetch('https://yvvvignywfmbdgkcxtfk.supabase.co/functions/v1/drive-connect/readiness', {headers:{Authorization:'Bearer '+JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>/^sb-.*-auth-token$/.test(k)))).access_token}}).then(r=>r.json())`
  → `redirectUri: "https://soty.pp.ua/oauth/drive/callback"`, `services.googleDrive: true`,
  `scopes: [drive.file]`. Never print the token.
- Drive round trip: in a space's settings the owner uses "renew connection" (or a test space
  connects a folder). Google must return via `/oauth/drive/callback` to `/team?drive=connected`.

If anything fails: redeploy the previous functions from `4eda1c1` with the same plan tooling
(or ask the owner), which restores the old behaviour; the web change is safe to leave, since it
falls back on its own.

### 6. Remove the old redirect URIs

Only after step 5 passed: remove every `https://yvvvignywfmbdgkcxtfk.supabase.co/...` redirect
URI from all clients in the project. After this, the `legacy` fallback cannot work any more —
that is expected.

### 7. Branding, Data Access, Audience, submit

- **Branding:** App name `Soty`; logo `docs/google-oauth/soty-logo-120.png`; support email the
  owner controls (ask which — `Soty.support@gmail.com` only if it is a project member or a group
  the owner manages); homepage `https://soty.pp.ua`; privacy `https://soty.pp.ua/privacy`;
  terms `https://soty.pp.ua/terms`; authorized domains: `soty.pp.ua` **only**; developer contact
  email the owner reads.
- **Data Access:** exactly `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`,
  `.../auth/drive.file`. Remove anything else.
- **Audience:** In production. Then "Verify branding" / submit.
- Google writes to the developer contact email. Tell the owner to watch it and to change
  nothing Google looked at (name, logo, URLs, domains, redirect URIs, scopes) until approval.

### 8. Close out

- Merge `025-google-brand-verification` into `beta-dev` (it is the same change on the dev line;
  resolve conflicts in `styles.css` by keeping both sides' rules).
- Record in memory: what was submitted and when, which client IDs exist, and the result of the
  open question below.
- Report to the owner in Ukrainian: what is live, what Google still has to do, what to watch.

## Open question worth settling (optional, no production writes)

`specs/011-team-workspace-rework/research.md` R1 says a folder picked under `drive.file` shows
none of the files put there outside Soty; production indexed ~6,000 files for the owner's
space. Either the R1 test was wrong or that account had once granted a wider scope. It matters
for new customers. Settle it only with a Google account that never used Soty, connecting a
folder whose files were uploaded in Drive directly — and only with the owner's go-ahead.
