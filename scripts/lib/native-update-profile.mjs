import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  writeFileSync,
  renameSync,
  unlinkSync
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export function betaUpdateProfile({ mode, profileId, fixtureOrigin, enabled, bundleId }) {
  if (profileId === undefined && fixtureOrigin === undefined) return null;
  if (mode !== 'beta' || enabled !== true || bundleId !== 'com.wishly.beta')
    throw new Error('NATIVE_UPDATE_PROFILE_FORBIDDEN');
  if (typeof profileId !== 'string' || !UUID.test(profileId))
    throw new Error('NATIVE_UPDATE_PROFILE_INVALID');
  let origin;
  try {
    origin = new URL(fixtureOrigin);
  } catch {
    /* rejected below */
  }
  if (
    !origin ||
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port ||
    Number(origin.port) < 1024 ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.origin !== fixtureOrigin
  )
    throw new Error('NATIVE_UPDATE_PROFILE_FIXTURE_INVALID');
  return { profileId, supportDirectoryName: `Soty Beta Updates ${profileId}`, fixtureOrigin };
}

export function profileFromPlist(plist, mode) {
  return betaUpdateProfile({
    mode,
    profileId: plist.SotyUpdateFixtureProfile,
    fixtureOrigin: plist.SotyUpdateFixtureOrigin,
    enabled: plist.SotyNativeUpdatesEnabled,
    bundleId: plist.CFBundleIdentifier
  });
}

/** Both the UUID and fixture authority are sealed by the bundle signature. */
export async function readBetaUpdateProfile(app, { required = false } = {}) {
  const release = JSON.parse(
    await readFile(path.join(app, 'Contents/Resources/release.json'), 'utf8')
  );
  const plist = JSON.parse(
    execFileSync(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')],
      { encoding: 'utf8', maxBuffer: 65536, timeout: 5000 }
    )
  );
  const profile = profileFromPlist(plist, release.channel);
  if (required && !profile) throw new Error('NATIVE_UPDATE_PROFILE_REQUIRED');
  return profile;
}

export function readArchiveBetaUpdateProfile(archive, expectedProfileId, expectedOrigin) {
  if (typeof expectedProfileId !== 'string' || !UUID.test(expectedProfileId))
    throw new Error('NATIVE_UPDATE_PROFILE_REQUIRED');
  const bytes = execFileSync(
    '/usr/bin/unzip',
    ['-p', archive, 'Soty Beta.app/Contents/Info.plist'],
    { maxBuffer: 65536, timeout: 15000 }
  );
  const plist = JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
      input: bytes,
      encoding: 'utf8',
      maxBuffer: 65536,
      timeout: 5000
    })
  );
  const profile = profileFromPlist(plist, 'beta');
  if (
    profile?.profileId !== expectedProfileId ||
    (expectedOrigin !== undefined && profile.fixtureOrigin !== expectedOrigin)
  )
    throw new Error('NATIVE_UPDATE_PROFILE_MISMATCH');
  return profile;
}

/** Append smoke work only to an idle, owned fixture; never reset qualification evidence. */
export function seedFixtureSmokeQueue(support, seed) {
  const readOwned = name => {
    let fd;
    try {
      fd = openSync(path.join(support, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.size > 4 * 1024 * 1024
      )
        throw new Error('NATIVE_UPDATE_PROFILE_UNSAFE');
      return JSON.parse(readFileSync(fd, 'utf8'));
    } finally {
      closeSync(fd);
    }
  };
  const native = readOwned('Updates/beta/native.json');
  if (
    native &&
    (native.schemaVersion !== 1 || !['idle', 'ui_visible', 'cancelled'].includes(native.stage))
  )
    throw new Error('NATIVE_UPDATE_PROFILE_BUSY');
  const previous = readOwned('state.json');
  if (
    previous &&
    (!Array.isArray(previous.jobs) ||
      !previous.settings ||
      previous.jobs.some(
        job => !['completed', 'failed', 'cancelled', 'interrupted'].includes(job?.status)
      ))
  )
    throw new Error('NATIVE_UPDATE_PROFILE_BUSY');
  const next = previous ? { ...previous, jobs: [...previous.jobs, ...seed.jobs] } : seed;
  const temporary = path.join(support, `.smoke-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path.join(support, 'state.json'));
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* renamed or never created */
    }
  }
}
