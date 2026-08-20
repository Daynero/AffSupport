// Generates the two ECDSA P-256 keypairs Soty uses for offline verification:
//
//   1. Agent entitlement tokens — the issue-agent-token Supabase Edge Function
//      signs short-lived tokens with the private key; the packaged agent embeds
//      the public key and refuses tool operations without a fresh valid token.
//   2. Stable release manifest — scripts/sign-release-manifest.mjs signs
//      stable.json; the web client verifies the signature before trusting
//      download URLs.
//
// Private keys are written to config/keys/ (gitignored) and must never be
// committed. Run once; refuse to overwrite existing keys so a published public
// key is never orphaned by accident.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const keysDir = path.join(process.cwd(), 'config', 'keys');
mkdirSync(keysDir, { recursive: true });

// `--beta` generates the separate keypair the beta staging environment signs
// entitlement tokens with. Beta MUST NOT reuse the production key: a distinct
// keypair is what makes a production-issued token cryptographically invalid in
// beta and a beta-issued token invalid in production, with no configuration to
// get wrong. The release-manifest key has no beta counterpart on purpose —
// beta never writes stable.json, so it never signs a manifest.
const beta = process.argv.includes('--beta');

const targets = beta
  ? [
      {
        name: 'beta-agent-entitlement',
        purpose: 'the beta issue-agent-token function (supabase/functions/.env.local)'
      }
    ]
  : [
      { name: 'agent-entitlement', purpose: 'issue-agent-token Edge Function (Supabase secret)' },
      {
        name: 'release-manifest',
        purpose: 'sign-release-manifest.mjs (kept on the release machine)'
      }
    ];

for (const target of targets) {
  const privatePath = path.join(keysDir, `${target.name}.private.pem`);
  if (existsSync(privatePath)) {
    process.stderr.write(`${privatePath} already exists; refusing to overwrite.\n`);
    continue;
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicSpkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  writeFileSync(privatePath, privatePem, { mode: 0o600 });
  writeFileSync(path.join(keysDir, `${target.name}.public.spki.b64`), publicSpkiBase64 + '\n');
  process.stdout.write(
    `${target.name}\n  private: ${privatePath}\n  used by: ${target.purpose}\n` +
      `  public (SPKI base64, safe to embed):\n  ${publicSpkiBase64}\n\n`
  );
}
