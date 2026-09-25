import type {
  LocalDirectoryHandle,
  LocalDropEntry
} from '../../apps/web/src/team/explorer/localManifest';

export function localFile(name: string, bytes = 1): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' });
}

export function handleFile(file: File): {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
} {
  return { kind: 'file', name: file.name, getFile: async () => file };
}

export function handleDirectory(
  name: string,
  children: Array<ReturnType<typeof handleFile> | LocalDirectoryHandle> = []
): LocalDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *values() {
      yield* children;
    }
  };
}

export function dropFile(file: File): LocalDropEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    file: success => success(file)
  };
}

export function dropDirectory(name: string, batches: LocalDropEntry[][]): LocalDropEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      const remaining = [...batches, []];
      return { readEntries: success => success(remaining.shift() ?? []) };
    }
  };
}
