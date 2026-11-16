import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readNativeUpdateQualification } from './lib/native-update-qualification.mjs';
import { betaUpdateProfile } from './lib/native-update-profile.mjs';
import { nativeUpdatePolicy } from './lib/native-update-inputs.mjs';
import {
  PREVIEW_SITE_ORIGIN,
  PRODUCTION_SITE_ORIGIN,
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64
} from '../packages/shared/dist/release.js';
const [app, mode] = process.argv.slice(2);
if (!app?.endsWith('.app') || !['production', 'beta', 'dev'].includes(mode ?? ''))
  throw new Error('NATIVE_UPDATE_CONFIG_ARGUMENTS');
const pins = JSON.parse(await readFile('config/native-updates.json', 'utf8'));
const fixture = process.env.SOTY_UPDATE_FIXTURE_ORIGIN;
if (fixture && mode !== 'beta') throw new Error('NATIVE_UPDATE_FIXTURE_FORBIDDEN');
if (fixture) {
  const url = new URL(fixture);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin !== fixture
  )
    throw new Error('NATIVE_UPDATE_FIXTURE_NOT_LOOPBACK');
}
const signed = process.env.SOTY_SIGNING_IDENTITY && process.env.SOTY_SIGNING_IDENTITY !== '-';
const policy = nativeUpdatePolicy(process.env);
const disabled = policy === 'disabled';
// A fixture exists only to exercise the updater; asking for both is a contradiction.
if (disabled && fixture) throw new Error('NATIVE_UPDATE_FIXTURE_REQUIRES_UPDATES');
// A deferred qualification (owner, 2026-11-16) is enforced by promote instead: the
// signed manifest advertising this build's updater cannot reach production without it.
if (mode === 'production' && signed && policy === 'enabled') {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await readNativeUpdateQualification(process.env.SOTY_NATIVE_UPDATE_QUALIFICATION, sourceSha);
}
const enabled = Boolean(
  signed && !disabled && (mode === 'production' || (mode === 'beta' && fixture))
);
if (fixture && !signed) throw new Error('NATIVE_UPDATE_FIXTURE_REQUIRES_DEVELOPER_ID');
const profile = betaUpdateProfile({
  mode,
  profileId: process.env.SOTY_UPDATE_FIXTURE_PROFILE,
  fixtureOrigin: fixture,
  enabled,
  bundleId: mode === 'beta' ? 'com.wishly.beta' : undefined
});
const channel = mode === 'production' ? 'stable' : 'beta';
const values = {
  SotyNativeUpdatesEnabled: ['bool', enabled ? 'true' : 'false'],
  SUEnableAutomaticChecks: ['bool', 'false'],
  SUAutomaticallyUpdate: ['bool', 'false'],
  SUAllowsAutomaticUpdates: ['bool', 'false'],
  SUEnableInstallerLauncherService: ['bool', 'false'],
  SUEnableDownloaderService: ['bool', 'false'],
  SUPublicEDKey: ['string', pins[channel].publicKey],
  SotyUpdateManifestPublicKey: [
    'string',
    channel === 'stable' ? RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64 : pins.beta.manifestPublicKey
  ],
  SotyUpdateManifestURL: ['string', `${PRODUCTION_SITE_ORIGIN}/.well-known/wishly/stable.json`],
  // The channel is never baked in: promote ships these exact bytes to production.
  // A Mac opts into the next address at runtime (`SotyUpdateChannel` = `next` in
  // the app's user defaults); this is the only other manifest it may read.
  ...(channel === 'stable'
    ? {
        SotyUpdateNextManifestURL: [
          'string',
          `${PREVIEW_SITE_ORIGIN}/.well-known/wishly/stable.json`
        ]
      }
    : {}),
  ...(fixture ? { SotyUpdateFixtureOrigin: ['string', fixture] } : {}),
  ...(profile ? { SotyUpdateFixtureProfile: ['string', profile.profileId] } : {})
};
// The only cleartext native request is the fixed read-only loopback appcast.
// ATS remains enabled for remote origins.
execFileSync('/usr/libexec/PlistBuddy', [
  '-c',
  'Add :NSAppTransportSecurity dict',
  `${app}/Contents/Info.plist`
]);
execFileSync('/usr/libexec/PlistBuddy', [
  '-c',
  'Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true',
  `${app}/Contents/Info.plist`
]);
for (const [key, [type, value]] of Object.entries(values)) {
  // No user-supplied text reaches PlistBuddy's command parser.
  if (!/^[A-Za-z0-9+/:._=-]+$/u.test(value)) throw new Error('NATIVE_UPDATE_CONFIG_INVALID');
  execFileSync('/usr/libexec/PlistBuddy', [
    '-c',
    `Add :${key} ${type} ${value}`,
    `${app}/Contents/Info.plist`
  ]);
}
