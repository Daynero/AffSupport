import {
  LOCAL_MANIFEST_BOUNDS,
  isLocalManifestRelativePath,
  type LocalManifestEntry,
  type LocalManifestIssueCode
} from '../../../../../packages/shared/src/team/transport';

export interface LocalFileHandle {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
}
export interface LocalDirectoryHandle {
  kind: 'directory';
  name: string;
  values: () => AsyncIterable<LocalFileHandle | LocalDirectoryHandle>;
}
export interface LocalDropEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?: (success: (file: File) => void, failure?: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: LocalDropEntry[]) => void,
      failure?: (error: unknown) => void
    ) => void;
  };
}
export type LocalManifestSource =
  | { kind: 'file'; file: File }
  | { kind: 'directory_handle'; handle: LocalDirectoryHandle }
  | { kind: 'drop_entry'; entry: LocalDropEntry };

export interface LocalManifestIssue {
  code: LocalManifestIssueCode;
  relativePath?: string;
  recoverable: boolean;
}
export interface LocalManifest {
  roots: Array<{ clientItemKey: string; kind: 'file' | 'directory'; name: string }>;
  entries: LocalManifestEntry[];
  issues: LocalManifestIssue[];
  totalFiles: number;
  totalDirectories: number;
  totalBytes: number;
}

type PendingDirectory = {
  source: LocalDirectoryHandle | LocalDropEntry;
  kind: 'handle' | 'drop';
  relativePath: string;
  parentKey: string;
};

function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function dropFile(entry: LocalDropEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    if (!entry.file) return reject(new Error('No file reader'));
    entry.file(resolve, reject);
  });
}

function dropBatch(
  reader: ReturnType<NonNullable<LocalDropEntry['createReader']>>
): Promise<LocalDropEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** Build a browser-only manifest. It contains File objects and must never be serialized to the server. */
export async function buildLocalManifest(
  sources: LocalManifestSource[],
  options: { signal?: AbortSignal } = {}
): Promise<LocalManifest> {
  const manifest: LocalManifest = {
    roots: [],
    entries: [],
    issues: [],
    totalFiles: 0,
    totalDirectories: 0,
    totalBytes: 0
  };
  const pending: PendingDirectory[] = [];
  const visited = new WeakSet<object>();
  const paths = new Set<string>();
  let halted = false;
  const issue = (code: LocalManifestIssueCode, relativePath?: string) => {
    manifest.issues.push({
      code,
      ...(relativePath ? { relativePath } : {}),
      recoverable: code !== 'INVALID_PATH'
    });
  };
  const canceled = () => {
    if (!options.signal?.aborted) return false;
    if (!manifest.issues.some(item => item.code === 'CANCELED')) issue('CANCELED');
    halted = true;
    return true;
  };
  const acceptPath = (relativePath: string) => {
    if (!isLocalManifestRelativePath(relativePath)) {
      issue('INVALID_PATH', relativePath);
      return null;
    }
    const comparisonPath = relativePath.normalize('NFC');
    if (paths.has(comparisonPath)) {
      issue('DUPLICATE', relativePath);
      return null;
    }
    paths.add(comparisonPath);
    return comparisonPath;
  };
  const addDirectory = (
    source: LocalDirectoryHandle | LocalDropEntry,
    kind: 'handle' | 'drop',
    relativePath: string,
    parentKey: string | null
  ) => {
    if (visited.has(source)) {
      issue('CYCLE', relativePath);
      return;
    }
    if (manifest.totalDirectories >= LOCAL_MANIFEST_BOUNDS.directories) {
      issue('LIMIT_EXCEEDED', relativePath);
      halted = true;
      return;
    }
    const comparisonPath = acceptPath(relativePath);
    if (comparisonPath === null) return;
    visited.add(source);
    const clientItemKey = `directory:${comparisonPath}`;
    manifest.entries.push({
      kind: 'directory',
      clientItemKey,
      relativePath,
      comparisonPath,
      parentKey,
      depth: relativePath.split('/').length - 1
    });
    manifest.totalDirectories += 1;
    if (parentKey === null)
      manifest.roots.push({ clientItemKey, kind: 'directory', name: source.name });
    pending.push({ source, kind, relativePath, parentKey: clientItemKey });
  };
  const addFile = async (
    read: () => Promise<File>,
    relativePath: string,
    parentKey: string | null
  ) => {
    if (manifest.totalFiles >= LOCAL_MANIFEST_BOUNDS.files) {
      issue('LIMIT_EXCEEDED', relativePath);
      halted = true;
      return;
    }
    if (!isLocalManifestRelativePath(relativePath)) {
      issue('INVALID_PATH', relativePath);
      return;
    }
    let file: File;
    try {
      file = await read();
    } catch {
      issue('UNREADABLE', relativePath);
      return;
    }
    if (canceled()) return;
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > LOCAL_MANIFEST_BOUNDS.fileBytes ||
      manifest.totalBytes + file.size > LOCAL_MANIFEST_BOUNDS.totalBytes
    ) {
      issue('LIMIT_EXCEEDED', relativePath);
      halted = true;
      return;
    }
    const comparisonPath = acceptPath(relativePath);
    if (comparisonPath === null) return;
    const clientItemKey = `file:${comparisonPath}:${file.size}`;
    manifest.entries.push({
      kind: 'file',
      clientItemKey,
      relativePath,
      comparisonPath,
      parentKey,
      depth: relativePath.split('/').length - 1,
      sizeBytes: file.size,
      mimeType: file.type,
      source: file
    });
    manifest.totalFiles += 1;
    manifest.totalBytes += file.size;
    if (parentKey === null) manifest.roots.push({ clientItemKey, kind: 'file', name: file.name });
  };

  if (canceled()) return manifest;
  for (const source of sources) {
    if (canceled() || halted) break;
    if (source.kind === 'file')
      await addFile(() => Promise.resolve(source.file), source.file.name, null);
    else if (source.kind === 'directory_handle')
      addDirectory(source.handle, 'handle', source.handle.name, null);
    else if (source.entry.isDirectory) addDirectory(source.entry, 'drop', source.entry.name, null);
    else if (source.entry.isFile)
      await addFile(() => dropFile(source.entry), source.entry.name, null);
    else issue('UNREADABLE', source.entry.name);
  }

  for (let index = 0; index < pending.length && !halted; index += 1) {
    if (canceled()) break;
    const directory = pending[index]!;
    try {
      if (directory.kind === 'handle') {
        const handle = directory.source as LocalDirectoryHandle;
        for await (const child of handle.values()) {
          if (canceled() || halted) break;
          const path = childPath(directory.relativePath, child.name);
          if (child.kind === 'directory') addDirectory(child, 'handle', path, directory.parentKey);
          else await addFile(() => child.getFile(), path, directory.parentKey);
        }
      } else {
        const entry = directory.source as LocalDropEntry;
        if (!entry.createReader) throw new Error('No directory reader');
        const reader = entry.createReader();
        while (!halted && !canceled()) {
          const batch = await dropBatch(reader);
          if (batch.length === 0) break;
          for (const child of batch) {
            if (canceled() || halted) break;
            const path = childPath(directory.relativePath, child.name);
            if (child.isDirectory) addDirectory(child, 'drop', path, directory.parentKey);
            else if (child.isFile) await addFile(() => dropFile(child), path, directory.parentKey);
            else issue('UNREADABLE', path);
          }
        }
      }
    } catch {
      if (!canceled()) issue('UNREADABLE', directory.relativePath);
    }
  }
  return manifest;
}
