import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Spinner, type Translate } from './ui';
import { WishlyMark } from './WishlyLogo';

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
        {importing ? <Spinner /> : <WishlyMark size={20} />}
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
