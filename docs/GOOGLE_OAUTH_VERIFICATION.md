# Google OAuth verification: Soty

This is the release checklist for Google OAuth. It separates the public Soty sign-in
from the future Google Drive workspace so we never ask Google to approve a feature that
users cannot actually use.

## Current allowed submission: Soty sign-in

The current public Soty release may use only these identity scopes through Supabase:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`

These do **not** grant Drive access. Before submitting brand verification, the project
owner must complete the following in Google Cloud Console:

1. Use a dedicated **production** Cloud project. Keep development and test projects
   separate.
2. Set the application name to **Soty**, with a reachable support email and developer
   contact email.
3. Set these exact, public URLs on the verified `soty.pp.ua` domain:
   - Homepage: `https://soty.pp.ua`
   - Privacy Policy: `https://soty.pp.ua/privacy`
   - Terms of Service: `https://soty.pp.ua/terms`
4. Verify `soty.pp.ua` in Google Search Console using an account that is also an Owner
   or Editor of the Cloud project.
5. Configure only the exact origins and redirect URI in `docs/SUPABASE_SETUP.md`.
   Do not add wildcards or a local origin to the production client.
6. Open all three public URLs in a signed-out browser. They must load without a login,
   show the Soty name, and the homepage must link to both legal pages.
7. Publish the OAuth app, then submit the branding review from Google Auth Platform.

To publish this identity-only release before Drive is ready, use:

```bash
npm run deploy:web:identity
```

This intentionally does not run `verify:team-production`; the regular `npm run deploy:web`
remains the only deployment path that asserts the Google Drive workspace is production-ready.

Do not change the public name, logo, homepage URL, Privacy URL, Terms URL, redirect URI,
or requested scopes during review. Those changes can trigger a new review.

## drive.file release (feature 011)

The team workspace ships on the **non-restricted** `drive.file` scope with the Google Picker
as the folder chooser, so it needs no restricted-scope review to work in production. The
owner-side checklist, recorded with a date when done:

1. OAuth consent screen publishing status **In production** (not Testing).
2. Scope list exactly: `openid`, `userinfo.email`, `userinfo.profile`,
   `https://www.googleapis.com/auth/drive.file`.
3. **Google Picker API** enabled on the same Cloud project.
4. A browser API key restricted to `https://soty.pp.ua` referrers and the Picker API only.
5. The Cloud project number recorded; both values set as `VITE_GOOGLE_PICKER_API_KEY` and
   `VITE_GOOGLE_PROJECT_NUMBER` in `apps/web/.env.production` (public values only).
6. `DRIVE_RESTRICTED_SCOPE_APPROVED` left unset (or `false`) on the Supabase deployment.

The restricted-scope packet below is prepared **in parallel and never blocks the release**
(clarification of 2026-08-27). After approval, set `DRIVE_RESTRICTED_SCOPE_APPROVED=true`;
existing connections gain the wider scope through `include_granted_scopes` on their next
authorization without the owner re-selecting anything.

## Google Drive restricted scope — not required for the 011 release

The team workspace currently has `DRIVE_OAUTH_MODE=disabled` in production. Its planned
scope is `https://www.googleapis.com/auth/drive`, which is a **restricted** scope. Do not
add it to the identity-only production OAuth project or claim that Drive is live until the
complete user journey works in production.

Restricted-scope review requires all of the following:

- a working public feature, not mocks or a roadmap;
- a screen-recorded demo of sign-in, the consent screen, choosing the team root, and each
  requested Drive action;
- a precise explanation of why `drive.file` cannot meet the implemented product flow;
- up-to-date public Privacy Policy disclosures matching the actual data flow;
- a Google review of the restricted scope; and
- the annual CASA security assessment after Google requests it.

Google recommends `drive.file`, a non-sensitive per-file scope, whenever the product can
use an explicit user selection flow. Before enabling Drive, make a deliberate product
decision:

| Product design                                                                     | Scope to request | Verification impact                                           |
| ---------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------- |
| User explicitly selects files/folders shared with Soty                             | `drive.file`     | Non-sensitive; avoids restricted-scope security assessment.   |
| Soty must browse and operate on arbitrary existing descendants of a connected root | `drive`          | Restricted; requires the full review and security assessment. |

The current specification describes the second design, so it must retain the restricted
scope until the product is redesigned around explicit per-file/folder selection. Do not
downscope in code without changing and testing that user journey.

## Drive submission packet (parallel, non-blocking)

Per the 2026-08-27 clarification the 011 release ships on `drive.file` alone; this packet is
prepared in parallel and blocks nothing. Checklist (kept outside the repository):

- [ ] Restricted scope added to the consent screen in a **separate** submission, never to the
      `drive.file` client the release uses.
- [ ] `DRIVE_RESTRICTED_SCOPE_APPROVED` stays unset until Google's approval mail is filed.
- [ ] Demo video shows the Picker flow, the folder tree, and one write inside the root.
- [ ] CASA assessment booked (Tier 2), report filed with the approval date.
- [ ] After approval: switch the scope set via `resolveDriveScopes`, and rely on
      `include_granted_scopes=true` so existing owners upgrade without losing `drive.file`.

Keep these values outside the repository, with no credentials or tokens:

- Cloud project number and OAuth client ID;
- owner and backup contact emails;
- exact scope list and the reason for each scope;
- public URLs and Search Console ownership evidence;
- unlisted demo-video URL and a short reviewer test account/instructions when requested;
- approval date, annual review date, and CASA Letter of Validation.

Suggested scope justification for the current design:

> Soty is a productivity tool for media buyers. A team owner explicitly connects one
> Google Drive root folder. Soty must enumerate and operate on existing files and nested
> folders inside that selected root for catalog search, preview, upload, download, edit,
> move, processing results, and Trash-based deletion. Every operation is constrained to
> that root and is initiated by an authorized team member. `drive.file` is insufficient
> for this implemented catalog because it grants access only to files opened, created, or
> explicitly shared with the app, not the existing descendant collection that Soty must
> catalog and manage.

Only use this justification if the feature demonstrably works exactly as stated.

## Sources

- [Google OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies)
- [Choosing Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google minimum-scope requirements](https://support.google.com/cloud/answer/13807380)
- [Google verification requirements](https://support.google.com/cloud/answer/13464321)
- [Google security assessment](https://support.google.com/cloud/answer/13465431)
