import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Closed toolchain mapping. Public artifact identity remains in shared/release. */
export function macosTarget(arch = 'arm64') {
  if (arch !== 'arm64' && arch !== 'x64')
    throw new Error('MACOS_TARGET_INVALID: expected arm64 or x64');
  const macho = arch === 'x64' ? 'x86_64' : 'arm64';
  return Object.freeze({
    arch,
    platform: `macos-${arch}`,
    macho,
    swift: `${macho}-apple-macos13.0`
  });
}

export function parseMacosTarget(args = []) {
  let selected;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value;
    if (arg === '--arch') value = args[++index];
    else if (arg.startsWith('--arch=')) value = arg.slice(7);
    else throw new Error(`MACOS_TARGET_ARGUMENT_INVALID: ${arg}`);
    if (selected !== undefined || !value)
      throw new Error('MACOS_TARGET_ARGUMENT_INVALID: missing or duplicate architecture');
    selected = macosTarget(value).arch;
  }
  return macosTarget(selected);
}

export function macosPaths(cwd, flavor, arch = 'arm64') {
  macosTarget(arch);
  if (!['production', 'dev', 'beta'].includes(flavor)) throw new Error('MACOS_FLAVOR_INVALID');
  const root = path.join(
    cwd,
    'release',
    ...(flavor === 'production' ? [] : [flavor]),
    ...(arch === 'arm64' ? [] : [arch])
  );
  const name = flavor === 'production' ? 'Soty' : flavor === 'dev' ? 'Soty Dev' : 'Soty Beta';
  return { root, app: path.join(root, `${name}.app`), name };
}

/** Cross-build and Rosetta execution cannot certify physical Intel acceptance. */
export function nativeAcceptanceAllowed({
  platform,
  runtimeArch,
  targetArch,
  armHardware,
  virtualized
}) {
  macosTarget(targetArch);
  return (
    platform === 'darwin' &&
    runtimeArch === targetArch &&
    (targetArch !== 'x64' || (armHardware === false && virtualized === false))
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [field, flavor, ...args] = process.argv.slice(2);
    const target = parseMacosTarget(args);
    const values = { ...target, ...macosPaths(process.cwd(), flavor, target.arch) };
    if (!Object.hasOwn(values, field)) throw new Error('MACOS_TARGET_FIELD_INVALID');
    process.stdout.write(values[field]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'MACOS_INSPECTION_FAILED'}\n`);
    process.exitCode = 2;
  }
}
