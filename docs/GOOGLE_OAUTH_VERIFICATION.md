# Google OAuth verification: Soty

Soty requests `openid`, `userinfo.email`, `userinfo.profile` and
`https://www.googleapis.com/auth/drive.file`. All four are non-sensitive, so Google asks for
**brand verification only**: no scope review, no demo video, no CASA security assessment.
Adding any other Drive scope (`drive`, `drive.readonly`, `drive.metadata*`) turns the
submission into a restricted-scope review with a paid annual assessment. Do not add one.

## What Google checks, and where Soty meets it

| Requirement                                                            | Where                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Every domain in the OAuth client is verified by the project owner      | Both returns land on `soty.pp.ua` (`supabase/functions/_shared/google-redirect.ts`)         |
| Homepage describes the app and why it asks for Google data, no login   | `apps/web/src/PublicHomePage.tsx` (`publicHomeDriveNote`)                                   |
| Homepage links to the Privacy Policy, reachable on any screen          | Footer link; the homepage scrolls where it does not fit                                     |
| Privacy Policy on the same domain, as HTML, describing Google data use | `/privacy` (`apps/web/src/pages/legal-content.ts`), also written to `privacy.html` at build |
| In-product disclosure where data is requested                          | `apps/web/src/team/drive/DriveDataUseNotice.tsx` on the connect step                        |
| Limited Use statement, no AI/ML training                               | Privacy Policy, section "Google data sharing, retention and deletion"                       |
| Sign-in button follows Google branding                                 | `apps/web/src/auth/AuthScreens.tsx`, standard "G" on a white button                         |

`<ref>.supabase.co` is on the Public Suffix List, so Google treats it as a domain of its own
that nobody but Supabase can verify. That is why sign-in no longer returns to Supabase: the
`google-sign-in` function runs the PKCE exchange against `https://soty.pp.ua/auth/callback`
and the browser signs in with `signInWithIdToken`. It takes over only when the function's
`GOOGLE_CLIENT_ID` is the client Supabase's Google provider uses; otherwise it answers
`legacy` and the old provider redirect keeps working. Drive returns to
`https://soty.pp.ua/oauth/drive/callback`, a page that forwards the query to
`drive-oauth-callback` unchanged.

## Rollout order

The order matters: a function that sends people to a redirect URI Google does not know
shows them Google's `redirect_uri_mismatch` page.

1. **Search Console.** Verify the domain `soty.pp.ua` (DNS TXT record in Cloudflare) with an
   account that is an Owner or Editor of the production Cloud project.
2. **Google Auth Platform → Clients → the web client** whose ID starts with `588652264319-`
   (the one Supabase's Google provider uses). Add, without removing anything yet:
   - Authorized JavaScript origin: `https://soty.pp.ua`
   - Authorized redirect URIs: `https://soty.pp.ua/auth/callback` and
     `https://soty.pp.ua/oauth/drive/callback`
3. **Deploy the web.** It carries `/oauth/drive/callback`; sign-in keeps the provider redirect
   until step 4.
4. **Deploy the functions** `google-sign-in`, `drive-connect`, `drive-oauth-callback`.
5. **Check.** Sign out and sign in with Google; Google must return to
   `soty.pp.ua/auth/callback`. Readiness (`drive-connect/readiness`) must report
   `redirectUri: https://soty.pp.ua/oauth/drive/callback`. If sign-in still goes through
   supabase.co, the function answered `legacy`: the Edge `GOOGLE_CLIENT_ID` is a different
   client from Supabase's, and one of the two must be changed to match.
6. **Remove** every `https://<ref>.supabase.co/...` redirect URI from the project's clients.
7. **Branding.** App name `Soty`; logo `docs/google-oauth/soty-logo-120.png` (120×120 PNG);
   homepage `https://soty.pp.ua`; privacy `https://soty.pp.ua/privacy`; terms
   `https://soty.pp.ua/terms`; authorized domain `soty.pp.ua` only; a support email the
   project owner controls; a developer contact email that is read.
8. **Data Access.** Exactly the four scopes above.
9. **Audience.** Publishing status _In production_, then submit brand verification.
   Automated checks take minutes; a manual review usually two to three business days.

During review, change nothing Google looked at: name, logo, homepage, privacy and terms URLs,
authorized domains, redirect URIs or scopes. Any of them restarts the review.

## Sources

- [Brand verification requirements](https://support.google.com/cloud/answer/13464321)
- [Homepage requirements](https://support.google.com/cloud/answer/13807376)
- [Privacy policy requirements](https://support.google.com/cloud/answer/13806988)
- [Authorized domains](https://support.google.com/cloud/answer/15549049)
- [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Sign in with Google branding](https://developers.google.com/identity/branding-guidelines)
- [Supabase: signInWithIdToken for Google](https://supabase.com/docs/guides/auth/social-login/auth-google)
