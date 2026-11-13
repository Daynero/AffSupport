import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SPARKLE, withSparkle } from './native-update-sdk.mjs';
import { isMachOFile } from './macos-payload.mjs';
/** Pinned upstream -> per-file pre-sign hashes -> final signing attestation. */
export async function verifyNativeUpdateEmbedding(app, signing) {
  let metadata;
  try {
    metadata = JSON.parse(
      await readFile(path.join(app, 'Contents/Resources/native-update-sdk.json'), 'utf8')
    );
  } catch (error) {
    const enabled = spawnSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :SotyNativeUpdatesEnabled', path.join(app, 'Contents/Info.plist')],
      { encoding: 'utf8' }
    ).stdout?.trim();
    if (enabled === 'true')
      throw new Error('NATIVE_UPDATE_SDK_METADATA_REQUIRED', { cause: error });
    return { enabled: false, legacy: true };
  }
  if (
    metadata.sha256 !== SPARKLE.sha256 ||
    metadata.version !== SPARKLE.version ||
    !Array.isArray(metadata.files)
  )
    throw new Error('NATIVE_UPDATE_SDK_PIN_MISMATCH');
  if (!signing?.files?.length) throw new Error('NATIVE_UPDATE_SIGNING_ATTESTATION_REQUIRED');
  await withSparkle(async sdk => {
    const framework = path.join(sdk, 'Sparkle.framework');
    const expected = new Map();
    for (const entry of await readdir(framework, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (await isMachOFile(file))
        expected.set(
          path.join('Contents/Frameworks/Sparkle.framework', path.relative(framework, file)),
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex')
        );
    }
    if (metadata.files.length !== expected.size)
      throw new Error('NATIVE_UPDATE_SDK_FILES_MISMATCH');
    for (const entry of metadata.files) {
      const proof = signing.files.find(file => file.path === entry.path);
      if (
        !expected.has(entry.path) ||
        expected.get(entry.path) !== entry.sha256 ||
        !proof ||
        proof.profile !== 'hardened' ||
        proof.before !== entry.sha256 ||
        createHash('sha256')
          .update(await readFile(path.join(app, entry.path)))
          .digest('hex') !== proof.after
      )
        throw new Error('NATIVE_UPDATE_SDK_ATTESTATION_MISMATCH');
      expected.delete(entry.path);
    }
    if (expected.size) throw new Error('NATIVE_UPDATE_SDK_FILES_MISMATCH');
  });
  return { enabled: true, sdk: SPARKLE.version, machO: metadata.files.length, staticOnly: true };
}
