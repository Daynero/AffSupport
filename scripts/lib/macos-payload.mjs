import { execFileSync } from 'node:child_process';
import { readdir, realpath, lstat, access, open } from 'node:fs/promises';
import path from 'node:path';
import { macosTarget } from './macos-target.mjs';

const system = value => {
  const normalized = path.posix.normalize(value);
  return normalized.startsWith('/usr/lib/') || normalized.startsWith('/System/Library/');
};
const relativeLoader = value => /^@(loader_path|executable_path|rpath)(?:\/|$)/u.test(value);
const atMost13 = value => {
  const parts = value.split('.').map(Number);
  return (
    parts.every(Number.isInteger) &&
    (parts[0] < 13 || (parts[0] === 13 && parts.slice(1).every(n => n === 0)))
  );
};

export async function isMachOFile(file) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return (
      bytesRead === 4 &&
      [
        'feedface',
        'feedfacf',
        'cefaedfe',
        'cffaedfe',
        'cafebabe',
        'bebafeca',
        'cafebabf',
        'bfbafeca'
      ].includes(header.toString('hex'))
    );
  } finally {
    await handle.close();
  }
}

export function validateMachOInspection(inspection, arch) {
  const target = macosTarget(arch);
  if (
    !inspection.platforms?.length ||
    inspection.platforms.some(value => !['1', 'MACOS'].includes(value))
  )
    throw new Error('MACOS_PAYLOAD_PLATFORM_MISMATCH');
  if (!inspection.slices.includes(target.macho)) throw new Error('MACOS_PAYLOAD_ARCH_MISMATCH');
  // The macOS 13 floor is the Intel promise (049): its engines are built here
  // for x86-64-v3 at 13.0. Apple Silicon reuses the engines every 1.3.x build
  // shipped, which declare macOS 15.5; holding them to 13 would refuse the
  // release rather than change what arm64 users run. A load command is still
  // required on both.
  if (!inspection.minimums.length || (arch === 'x64' && !inspection.minimums.every(atMost13)))
    throw new Error('MACOS_PAYLOAD_OS_UNSUPPORTED');
  if (inspection.dependencies.some(value => !system(value) && !relativeLoader(value)))
    throw new Error('MACOS_PAYLOAD_DEPENDENCY_EXTERNAL');
  if (
    inspection.rpaths.some(
      value => !system(value) && !/^@(loader_path|executable_path)(?:\/|$)/u.test(value)
    )
  )
    throw new Error('MACOS_PAYLOAD_RPATH_EXTERNAL');
}

/** Never executes payload. Inspect every nested native module, dylib and browser helper. */
export async function verifyMacosPayload(root, arch) {
  const target = macosTarget(arch);
  root = await realpath(root);
  const run = (command, args) =>
    execFileSync(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const contained = value => value === root || value.startsWith(`${root}${path.sep}`);
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (!contained(await realpath(file))) throw new Error('MACOS_PAYLOAD_SYMLINK_EXTERNAL');
      } else if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const native = await isMachOFile(file);
        if (native) files.push(file);
        else if (path.extname(file) === '.node')
          throw new Error('MACOS_PAYLOAD_NATIVE_MODULE_INVALID');
      }
    }
  }
  await walk(root);
  if (!files.length) throw new Error('MACOS_PAYLOAD_NATIVE_MISSING');
  const inspected = new Set(files);
  for (const file of files) {
    const slices = run('/usr/bin/lipo', ['-archs', file]).trim().split(/\s+/u);
    if (!slices.includes(target.macho))
      throw new Error(`MACOS_PAYLOAD_ARCH_MISMATCH: ${path.relative(root, file)}`);
    const loads = run('/usr/bin/otool', ['-arch', target.macho, '-l', file]);
    const dependencies = [
      ...loads.matchAll(
        /cmd LC_(?:LOAD|LOAD_WEAK|REEXPORT|LOAD_UPWARD)_DYLIB\s+cmdsize \d+\s+name (.+?) \(offset \d+\)/gu
      )
    ].map(match => match[1]);
    const rpaths = [
      ...loads.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/gu)
    ].map(match => match[1]);
    const inspection = {
      slices,
      platforms: [
        ...loads.matchAll(/cmd LC_BUILD_VERSION\b(?:(?!\nLoad command)[\s\S])*?\bplatform (\w+)/gu)
      ].map(match => match[1]),
      minimums: [...loads.matchAll(/\b(?:minos|version) (\d+\.\d+(?:\.\d+)?)\b/gu)]
        // Only deployment commands, not dylib versions.
        .map(match => match[1]),
      dependencies,
      rpaths
    };
    if (/cmd LC_VERSION_MIN_MACOSX\b/u.test(loads)) inspection.platforms.push('1');
    inspection.minimums = [
      ...loads.matchAll(
        /cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\b(?:(?!\nLoad command)[\s\S])*?\b(?:minos|version) (\d+\.\d+(?:\.\d+)?)/gu
      )
    ].map(match => match[1]);
    try {
      validateMachOInspection(inspection, arch);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : 'MACOS_INSPECTION_FAILED'}: ${path.relative(root, file)}`,
        { cause: error }
      );
    }
    // Resolve only within the sealed bundle. Inherited rpaths are intentionally
    // not guessed: approved portable inputs must carry resolvable own paths.
    const executable = file.includes('/Contents/MacOS/')
      ? path.dirname(file)
      : path.join(root, 'Contents/MacOS');
    const expand = value =>
      value.replace(/^@loader_path/u, path.dirname(file)).replace(/^@executable_path/u, executable);
    for (const rpath of rpaths) {
      const expanded = path.resolve(expand(rpath));
      if (!system(expanded) && !contained(expanded))
        throw new Error('MACOS_PAYLOAD_RPATH_EXTERNAL');
    }
    for (const dependency of dependencies.filter(value => !system(value))) {
      const candidates = dependency.startsWith('@rpath/')
        ? rpaths.map(rpath => path.resolve(expand(rpath), dependency.slice(7)))
        : [path.resolve(expand(dependency))];
      let found = false;
      for (const candidate of candidates) {
        if (system(candidate)) {
          found = true;
          break;
        }
        const resolved = await realpath(candidate).catch(() => null);
        if (resolved && contained(resolved) && inspected.has(resolved)) {
          found = true;
          break;
        }
      }
      if (!found)
        throw new Error(`MACOS_PAYLOAD_DEPENDENCY_UNRESOLVED: ${path.relative(root, file)}`);
    }
    if ((await lstat(file)).mode & 0o111) await access(file);
  }
  return { target: target.platform, nativeFileCount: files.length, staticOnly: true };
}
