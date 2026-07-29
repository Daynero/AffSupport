// Signs the stable release manifest with the release key and (optionally)
// records the sha256 of a built artifact. The web client refuses unsigned or
// mis-signed manifests, so this must run before deploy:web whenever
// stable.json changes.
//
//   node scripts/sign-release-manifest.mjs [--dmg path [--platform macos-arm64]]
//
// The private key is read from RELEASE_SIGNING_KEY_PATH or the default
// config/keys/release-manifest.private.pem (gitignored; generated once via
// scripts/generate-signing-keys.mjs).
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64,
  releaseManifestSigningPayload
} from '../packages/shared/dist/release.js';

const manifestPath = 'apps/web/public/.well-known/wishly/stable.json';
const keyPath = process.env.RELEASE_SIGNING_KEY_PATH || 'config/keys/release-manifest.private.pem';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const privateKey = createPrivateKey(readFileSync(keyPath));
const embeddedPublicKey = createPublicKey({
  key: Buffer.from(RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64, 'base64'),
  format: 'der',
  type: 'spki'
});
const derivedPublic = createPublicKey(privateKey)
  .export({ type: 'spki', format: 'der' })
  .toString('base64');
if (derivedPublic !== RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64) {
  process.stderr.write(
    'Private key does not match RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64 in packages/shared.\n'
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const dmgPath = option('dmg');
if (dmgPath) {
  const platform = option('platform') ?? 'macos-arm64';
  const artifact = manifest.artifacts?.[platform];
  if (!artifact) {
    process.stderr.write(`Manifest has no ${platform} artifact to attach the checksum to.\n`);
    process.exit(1);
  }
  artifact.sha256 = createHash('sha256').update(readFileSync(dmgPath)).digest('hex');
  process.stdout.write(`${platform} sha256 = ${artifact.sha256}\n`);
}

const payload = Buffer.from(releaseManifestSigningPayload(manifest), 'utf8');
manifest.signature = sign('sha256', payload, {
  key: privateKey,
  dsaEncoding: 'ieee-p1363'
}).toString('base64url');

const check = verify(
  'sha256',
  payload,
  { key: embeddedPublicKey, dsaEncoding: 'ieee-p1363' },
  Buffer.from(manifest.signature, 'base64url')
);
if (!check) {
  process.stderr.write('Self-check failed: signature does not verify with the embedded key.\n');
  process.exit(1);
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`Signed ${manifestPath}\n`);
