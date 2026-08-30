import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Spinner, type Translate } from './ui';
import { Upload } from 'lucide-react';
import { ICON_STROKE } from './icons';

export function DropZone({
  disabled,
  importing,
  chooseFiles,
  addDroppedFiles,
  addDroppedFilePaths,
  onDropData,
  title,
  formats,
  activeLabel,
  importingLabel,
  t
}: {
  disabled: boolean;
  importing: boolean;
  chooseFiles: () => void;
  addDroppedFiles: (files: File[]) => void;
  addDroppedFilePaths?: (paths: string[]) => void;
  /** When provided, the raw transfer is handed over (e.g. to read folders). */
  onDropData?: (data: DataTransfer) => void;
  title?: string;
  formats?: string;
  activeLabel?: string;
  importingLabel?: string;
  t: Translate;
}) {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    depth.current++;
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (disabled) return;
    if (onDropData) {
      onDropData(event.dataTransfer);
      return;
    }
    const paths = droppedFilePaths(event.dataTransfer);
    if (paths.length && addDroppedFilePaths) {
      addDroppedFilePaths(paths);
      return;
    }
    const files = droppedFiles(event.dataTransfer.files);
    if (files.length) addDroppedFiles(files);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    chooseFiles();
  };

  return (
    <div
      className={`drop-zone ${dragging ? 'is-dragging' : ''} ${disabled ? 'is-disabled' : ''}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={title ?? t('dropTitle')}
      onClick={() => !disabled && chooseFiles()}
      onKeyDown={onKeyDown}
      onDragEnter={onDragEnter}
      onDragOver={event => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="drop-icon" aria-hidden="true">
        {importing ? <Spinner /> : <Upload size={44} strokeWidth={ICON_STROKE} />}
      </span>
      <div>
        <strong>
          {importing
            ? (importingLabel ?? t('importingFiles'))
            : dragging
              ? (activeLabel ?? t('dropActive'))
              : (title ?? t('dropTitle'))}
        </strong>
        <span>{formats ?? t('dropFormats')}</span>
      </div>
    </div>
  );
}

export function droppedFiles(files: ArrayLike<File>): File[] {
  return Array.from(files);
}

/**
 * A dropped folder described by its name plus one sample file inside it — enough for the agent to
 * find the folder back on disk when the browser refuses to expose its absolute path.
 */
export interface DroppedFolderSample {
  folderName: string;
  /** Sample file's path relative to the dropped folder, POSIX separators. */
  relPath: string;
  fileName: string;
  size: number;
  lastModified: number;
}

/**
 * Synchronously grab the first dropped directory entry. MUST be called inside the drop handler:
 * `webkitGetAsEntry()` is only valid for the duration of the event, though the returned entry stays
 * usable afterwards for the async read in {@link sampleDroppedFolder}.
 */
export function firstDroppedDirectory(data: DataTransfer): FileSystemDirectoryEntry | null {
  const items = data.items ? Array.from(data.items) : [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory) return entry as FileSystemDirectoryEntry;
  }
  return null;
}

/**
 * Walk a dropped directory breadth-first to the first ordinary, non-empty file (skipping dotfiles
 * such as `.DS_Store`, which would match too many folders), and describe it as a
 * {@link DroppedFolderSample}. Returns `null` if the folder holds no usable sample file.
 */
export async function sampleDroppedFolder(
  dir: FileSystemDirectoryEntry
): Promise<DroppedFolderSample | null> {
  const queue: { entry: FileSystemEntry; rel: string }[] = [{ entry: dir, rel: '' }];
  let guard = 0;
  while (queue.length && guard++ < 10_000) {
    const { entry, rel } = queue.shift()!;
    if (entry.isFile) {
      if (entry.name.startsWith('.')) continue;
      const file = await entryToFile(entry as FileSystemFileEntry);
      if (file && file.size > 0) {
        return {
          folderName: dir.name,
          relPath: rel,
          fileName: file.name,
          size: file.size,
          lastModified: file.lastModified
        };
      }
    } else if (entry.isDirectory) {
      const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
      for (const child of children) {
        queue.push({ entry: child, rel: rel ? `${rel}/${child.name}` : child.name });
      }
    }
  }
  return null;
}

function entryToFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise(resolve => entry.file(resolve, () => resolve(null)));
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  return new Promise(resolve => {
    const step = () =>
      reader.readEntries(
        batch => {
          if (!batch.length) {
            resolve(all);
            return;
          }
          all.push(...batch);
          step();
        },
        () => resolve(all)
      );
    step();
  });
}

/** Extract Finder's source paths when the browser exposes the file URI list. */
export function droppedFilePaths(data: DataTransfer): string[] {
  let uriList: string;
  try {
    uriList = data.getData('text/uri-list');
  } catch {
    return [];
  }
  return uriList
    .split(/\r?\n/)
    .filter(value => value && !value.startsWith('#'))
    .flatMap(value => {
      try {
        const url = new URL(value);
        if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return [];
        return [decodeURIComponent(url.pathname)];
      } catch {
        return [];
      }
    });
}
