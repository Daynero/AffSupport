// Local one-time provisioning. Private seeds never enter the checkout or CI.
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = path.join(os.homedir(), 'Library/Application Support/Soty/signing');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const pinPath = 'config/native-updates.json';
const pins = existsSync(pinPath) ? JSON.parse(readFileSync(pinPath, 'utf8')) : { schemaVersion: 1 };
for (const channel of ['stable', 'beta']) {
  const file = path.join(directory, `updater-${channel}.seed`);
  let key;
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
      throw new Error('UPDATER_KEY_PERMISSIONS');
    const seed = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (seed.length !== 32) throw new Error('UPDATER_KEY_INVALID');
    key = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der',
      type: 'pkcs8'
    });
  } else {
    key = generateKeyPairSync('ed25519').privateKey;
    const seed = key.export({ format: 'jwk' }).d;
    if (typeof seed !== 'string') throw new Error('UPDATER_KEY_INVALID');
    writeFileSync(file, Buffer.from(seed, 'base64url').toString('base64') + '\n', {
      mode: 0o600,
      flag: 'wx'
    });
  }
  const publicX = createPublicKey(key).export({ format: 'jwk' }).x;
  if (typeof publicX !== 'string') throw new Error('UPDATER_KEY_INVALID');
  const publicKey = Buffer.from(publicX, 'base64url').toString('base64');
  if (pins[channel]?.publicKey && pins[channel].publicKey !== publicKey)
    throw new Error('UPDATER_KEY_PIN_MISMATCH');
  pins[channel] = { publicKey };
}
const fixtureKey = path.join(directory, 'updater-beta-manifest.private.pem');
if (!existsSync(fixtureKey))
  writeFileSync(
    fixtureKey,
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
      format: 'pem',
      type: 'pkcs8'
    }),
    { mode: 0o600, flag: 'wx' }
  );
const betaPublic = createPublicKey(readFileSync(fixtureKey))
  .export({ format: 'der', type: 'spki' })
  .toString('base64');
if (pins.beta.manifestPublicKey && pins.beta.manifestPublicKey !== betaPublic)
  throw new Error('BETA_MANIFEST_PIN_MISMATCH');
pins.beta.manifestPublicKey = betaPublic;
writeFileSync(pinPath, JSON.stringify(pins, null, 2) + '\n');
process.stdout.write(
  'Native update public keys pinned; private keys remain in the local signing directory.\n'
);
