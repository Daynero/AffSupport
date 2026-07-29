# issue-agent-token

Issues short-lived (12h) ECDSA P-256 signed entitlement tokens for the local
Wishly Agent. The web app exchanges the signed-in Supabase session for a token
and forwards it to the agent; the packaged agent verifies the signature offline
with the embedded public key and refuses tool operations without a valid token
(plus a 7-day offline grace window handled by the agent).

Blocking a user is server-side: set `profiles.account_status = 'blocked'` and
this function stops issuing tokens for that account immediately.

## Deploy

```bash
# One-time: store the private key (base64 of the PKCS8 DER) as a secret.
# The keypair comes from `node scripts/generate-signing-keys.mjs`
# (config/keys/agent-entitlement.private.pem, gitignored).
node -e "const{readFileSync}=require('fs');const{createPrivateKey}=require('crypto');process.stdout.write(createPrivateKey(readFileSync('config/keys/agent-entitlement.private.pem')).export({type:'pkcs8',format:'der'}).toString('base64'))" \
  | xargs -I{} npx supabase secrets set AGENT_TOKEN_PRIVATE_KEY={}
npx supabase secrets set WISHLY_SITE_URL=https://wishly-app.pages.dev

npx supabase functions deploy issue-agent-token
```

The matching public key (SPKI, base64) is embedded into packaged builds via
`AGENT_ENTITLEMENT_PUBLIC_KEY` in `config/production.env`. Development builds
leave it unset, which disables enforcement.
