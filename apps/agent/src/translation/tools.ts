import { accessSync, constants, existsSync } from 'node:fs';
import { access, chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationSupportRoot } from '../files/support-dir.js';
import {
  currentArch,
  currentPlatform,
  executableName,
  extractTarGz,
  listTarGzEntries,
  listZipEntries,
  unzipArchive
} from '../platform/platform.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Same packaged/source offset the ffmpeg + whisper tools use.
const packagedRuntime = path.resolve(here, '../../../runtime');
const localRuntime = path.resolve(here, '../../runtime');
const supportRoot = applicationSupportRoot();

/** One pinned llama.cpp release build for one supported OS/CPU pair. */
export interface TranslationRuntimeDescriptor {
  label: string;
  tag: string;
  revision: string;
  archiveName: string;
  /** `tar.gz` extracts through the tar path; `zip` through unzipArchive (bsdtar on Windows). */
  archiveKind: 'tar.gz' | 'zip';
  /** The archive's single top-level directory, or null when entries sit at the archive root. */
  extractedDirectory: string | null;
  /** Directory name the runtime is installed into under `<App Support>/runtime`. */
  installDirectory: string;
  executableName: string;
  url: string;
  /**
   * null means the checksum has not been pinned on real bytes yet; the
   * downloader refuses to fetch such a descriptor (see whisper/downloader.ts).
   * docs/WINDOWS.md describes how to pin it.
   */
  sha256: string | null;
  /** 0 = unknown until the checksum is pinned (disables the exact-size check). */
  sizeBytes: number;
}

export type TranslationRuntimePlatform = 'darwin-arm64' | 'win32-x64';

/**
 * llama.cpp is pinned independently from the model, one descriptor per
 * supported platform. Each official release archive contains `llama-server`
 * plus its adjacent shared libraries; Soty runs it bound to the loopback
 * interface only, authenticated with a per-launch API key.
 */
export const TRANSLATION_RUNTIME_DESCRIPTORS: Record<
  TranslationRuntimePlatform,
  TranslationRuntimeDescriptor
> = {
  'darwin-arm64': {
    label: 'llama.cpp b10092 (Apple Silicon)',
    tag: 'b10092',
    revision: '3ce7da2c852c538c4c5f9806da27029cf8c9cc4a',
    archiveName: 'llama-b10092-bin-macos-arm64.tar.gz',
    archiveKind: 'tar.gz',
    extractedDirectory: 'llama-b10092',
    installDirectory: 'llama-b10092',
    executableName: 'llama-server',
    url:
      'https://github.com/ggml-org/llama.cpp/releases/download/b10092/' +
      'llama-b10092-bin-macos-arm64.tar.gz',
    sha256: 'f3ec2351e06322478e3f38f23f5339cd834cca5e3740f334ce2bdc5de95f90e0',
    sizeBytes: 10_612_780
  },
  'win32-x64': {
    label: 'llama.cpp b10092 (Windows x64, CPU)',
    tag: 'b10092',
    revision: '3ce7da2c852c538c4c5f9806da27029cf8c9cc4a',
    // The CPU build works everywhere; GPU (vulkan/cuda) variants can be pinned
    // later without touching the install flow. Windows release zips are flat:
    // llama-server.exe and its DLLs sit at the archive root.
    archiveName: 'llama-b10092-bin-win-cpu-x64.zip',
    archiveKind: 'zip',
    extractedDirectory: null,
    installDirectory: 'llama-b10092-win-x64',
    executableName: 'llama-server',
    url:
      'https://github.com/ggml-org/llama.cpp/releases/download/b10092/' +
      'llama-b10092-bin-win-cpu-x64.zip',
    // Recorded from the published release asset (GitHub's release API exposes
    // a per-asset digest, cross-checked against the macOS asset whose hash was
    // already pinned here). No Windows machine is needed to pin this.
    sha256: 'c842fa7dc90e32b327c62903f4310ef251a902c90ef5b3a6c01c6b675dce078e',
    sizeBytes: 18_021_876
  }
};

/**
 * Picks the pinned llama.cpp build for a platform/arch pair, or null when the
 * local translation runtime is not supported there. Pure so unit tests can
 * exercise every branch without stubbing process.
 */
export function selectTranslationRuntimeDescriptor(
  platform: NodeJS.Platform = currentPlatform(),
  arch: string = currentArch()
): TranslationRuntimeDescriptor | null {
  const key = `${platform}-${arch}`;
  return key in TRANSLATION_RUNTIME_DESCRIPTORS
    ? TRANSLATION_RUNTIME_DESCRIPTORS[key as TranslationRuntimePlatform]
    : null;
}

const activeRuntimeDescriptor = selectTranslationRuntimeDescriptor();

/**
 * Descriptor for the current process. On unsupported platforms this falls back
 * to the macOS build so path/version helpers keep working; installation itself
 * refuses (installTranslationRuntimeArchive checks the real support matrix).
 */
export const TRANSLATION_RUNTIME_DESCRIPTOR: TranslationRuntimeDescriptor =
  activeRuntimeDescriptor ?? TRANSLATION_RUNTIME_DESCRIPTORS['darwin-arm64'];

/** Writable location the on-demand model download writes to (shared with whisper). */
const downloadModelsDir = path.join(supportRoot, 'models');
const bundledModelsDir = path.join(
  process.env.PACKAGED_APP === '1' ? packagedRuntime : localRuntime,
  'models'
);
const downloadedRuntimeDir = path.join(
  supportRoot,
  'runtime',
  TRANSLATION_RUNTIME_DESCRIPTOR.installDirectory
);
const bundledTranslationRuntimeDir = path.join(
  process.env.PACKAGED_APP === '1' ? packagedRuntime : localRuntime,
  'llama'
);

/**
 * TranslateGemma 4B IT, Q4_K_M GGUF.
 *
 * Google publishes the source checkpoint behind the Gemma terms gate rather
 * than publishing an official GGUF. This immutable conversion is pinned by
 * repository revision, exact byte size and SHA-256. Its GGUF metadata identifies
 * the TranslateGemma/Gemma 3 architecture and embeds Google's opinionated
 * translation chat template. The conversion provenance and reproduction recipe
 * are recorded in THIRD_PARTY_NOTICES.md.
 */
export const TRANSLATION_MODEL_DESCRIPTOR = {
  label: 'TranslateGemma 4B IT (Q4_K_M)',
  baseModel: 'google/translategemma-4b-it',
  baseRevision: '10042cb0e6e7fdce748996a71dc3dc432a4e0c89',
  artifactRevision: '74307c4cbd921b1f524ec90113e3c4cf0466e98c',
  fileName: 'translategemma-4b-it-Q4_K_M.gguf',
  url:
    process.env.TRANSLATION_MODEL_URL ??
    'https://huggingface.co/datasets/ctc88haha/' +
      'translategemma-4b-it-Q4_K_M-GGUF/resolve/' +
      '74307c4cbd921b1f524ec90113e3c4cf0466e98c/' +
      'translategemma-4b-it-Q4_K_M.gguf',
  sha256:
    process.env.TRANSLATION_MODEL_SHA256 ??
    '8040937f77f3c0612461d833cdf7696282444c7aded00250b3924be9652f2055',
  sizeBytes: Number(process.env.TRANSLATION_MODEL_SIZE ?? 2_489_909_120)
} as const;

/**
 * Multilingual E5 Small, Q4_K_M. The upstream model is MIT-licensed and trained
 * for multilingual semantic similarity/bitext mining; this immutable GGUF is
 * used only to align already-local source and target phrases.
 */
export const ALIGNMENT_MODEL_DESCRIPTOR = {
  label: 'Multilingual E5 Small alignment model (Q4_K_M)',
  baseModel: 'intfloat/multilingual-e5-small',
  baseRevision: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
  artifactRevision: '3251974431b4ec1b9f6b0335edebedc505ec36d8',
  fileName: 'multilingual-e5-small-Q4_K_M.gguf',
  url:
    'https://huggingface.co/keisuke-miyako/' +
    'multilingual-e5-small-gguf-q4_k_m/resolve/' +
    '3251974431b4ec1b9f6b0335edebedc505ec36d8/' +
    'multilingual-e5-small-Q4_k_m.gguf',
  sha256: '6661b6e1ccb06e3044e2cd7aa25ca0b837ef7224a2cb5aff3a9e6807c60d01f1',
  sizeBytes: 124_350_304
} as const;

/** Absolute path to the pinned llama.cpp server (dev override → download → bundle). */
export function translationRuntimePath(): string {
  if (process.env.TRANSLATION_RUNTIME_PATH) return process.env.TRANSLATION_RUNTIME_PATH;
  const candidates = [
    path.join(downloadedRuntimeDir, executableName(TRANSLATION_RUNTIME_DESCRIPTOR.executableName)),
    path.join(
      bundledTranslationRuntimeDir,
      executableName(TRANSLATION_RUNTIME_DESCRIPTOR.executableName)
    )
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return candidates[0];
}

export function translationRuntimePresent(): boolean {
  try {
    accessSync(translationRuntimePath(), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to the translator model (dev override → download → bundle). */
export function translationModelPath(): string {
  if (process.env.TRANSLATION_MODEL_PATH) return process.env.TRANSLATION_MODEL_PATH;
  const candidates = [
    path.join(downloadModelsDir, TRANSLATION_MODEL_DESCRIPTOR.fileName),
    path.join(bundledModelsDir, TRANSLATION_MODEL_DESCRIPTOR.fileName)
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return candidates[0];
}

/** Writable path the on-demand translator download writes to (App Support). */
export function translationModelDownloadPath(): string {
  return path.join(downloadModelsDir, TRANSLATION_MODEL_DESCRIPTOR.fileName);
}

export function translationModelPresent(): boolean {
  if (process.env.TRANSLATION_MODEL_PATH) return existsSync(process.env.TRANSLATION_MODEL_PATH);
  return [
    path.join(downloadModelsDir, TRANSLATION_MODEL_DESCRIPTOR.fileName),
    path.join(bundledModelsDir, TRANSLATION_MODEL_DESCRIPTOR.fileName)
  ].some(existsSync);
}

/** Validates the installed container and places Gemma's required notice beside it. */
export async function finalizeTranslationModelArtifact(modelPath: string): Promise<void> {
  const handle = await open(modelPath, 'r');
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, magic.length, 0);
    if (magic.toString('ascii') !== 'GGUF') {
      throw new Error('The translation model is not a GGUF artifact.');
    }
  } finally {
    await handle.close();
  }
  await writeFile(
    path.join(path.dirname(modelPath), 'NOTICE-Gemma.txt'),
    [
      'Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms',
      '',
      'TranslateGemma attribution: TranslateGemma is provided by Google.',
      '',
      `${path.basename(modelPath)} is a converted and quantized derivative of`,
      `${TRANSLATION_MODEL_DESCRIPTOR.baseModel}@${TRANSLATION_MODEL_DESCRIPTOR.baseRevision}.`,
      'It is not an official Google GGUF.',
      ''
    ].join('\n'),
    'utf8'
  );
}

/** The verified release archive is kept only until extraction succeeds. */
export function translationRuntimeArchiveDownloadPath(): string {
  return path.join(supportRoot, 'runtime', TRANSLATION_RUNTIME_DESCRIPTOR.archiveName);
}

/**
 * Safely extracts the verified official llama.cpp archive, validates the
 * expected layout and executable, then atomically installs its directory.
 */
export async function installTranslationRuntimeArchive(archivePath: string): Promise<void> {
  if (!activeRuntimeDescriptor) {
    throw new Error(
      `The local translation runtime is not available for ${currentPlatform()}-${currentArch()} yet.`
    );
  }
  const descriptor = activeRuntimeDescriptor;
  const parent = path.dirname(downloadedRuntimeDir);
  const staging = `${downloadedRuntimeDir}.installing`;
  await mkdir(parent, { recursive: true });
  await rm(staging, { recursive: true, force: true });

  const expectedRoot =
    descriptor.extractedDirectory === null ? null : `${descriptor.extractedDirectory}/`;
  const entries =
    descriptor.archiveKind === 'zip'
      ? await listZipEntries(archivePath)
      : await listTarGzEntries(archivePath);
  if (
    entries.length === 0 ||
    entries.some(
      entry =>
        entry.startsWith('/') ||
        /^[A-Za-z]:/u.test(entry) ||
        entry.includes('../') ||
        entry.includes('..\\') ||
        (expectedRoot !== null &&
          entry !== descriptor.extractedDirectory &&
          !entry.startsWith(expectedRoot))
    )
  ) {
    throw new Error('The translation runtime archive has an unsafe layout.');
  }

  await mkdir(staging, { recursive: true });
  try {
    if (descriptor.archiveKind === 'zip') await unzipArchive(archivePath, staging);
    else await extractTarGz(archivePath, staging);
    // Flat archives (the Windows zip) become the runtime directory themselves;
    // rooted archives (the macOS tarball) contribute their top-level directory.
    const extracted =
      descriptor.extractedDirectory === null
        ? staging
        : path.join(staging, descriptor.extractedDirectory);
    const executable = path.join(extracted, executableName(descriptor.executableName));
    await access(executable, constants.R_OK);
    await chmod(executable, 0o755);
    await rm(downloadedRuntimeDir, { recursive: true, force: true });
    await rename(extracted, downloadedRuntimeDir);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await rm(archivePath, { force: true }).catch(() => {});
  }
}

/** Absolute path to the alignment model (dev override → download → bundle). */
export function alignmentModelPath(): string {
  if (process.env.ALIGNMENT_MODEL_PATH) return process.env.ALIGNMENT_MODEL_PATH;
  const candidates = [
    path.join(downloadModelsDir, ALIGNMENT_MODEL_DESCRIPTOR.fileName),
    path.join(bundledModelsDir, ALIGNMENT_MODEL_DESCRIPTOR.fileName)
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return candidates[0];
}

export function alignmentModelDownloadPath(): string {
  return path.join(downloadModelsDir, ALIGNMENT_MODEL_DESCRIPTOR.fileName);
}

export function alignmentModelPresent(): boolean {
  if (process.env.ALIGNMENT_MODEL_PATH) return existsSync(process.env.ALIGNMENT_MODEL_PATH);
  return [
    path.join(downloadModelsDir, ALIGNMENT_MODEL_DESCRIPTOR.fileName),
    path.join(bundledModelsDir, ALIGNMENT_MODEL_DESCRIPTOR.fileName)
  ].some(existsSync);
}
