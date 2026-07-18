import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Spinner, type Translate } from './ui';

export function DropZone({
  disabled,
  importing,
  chooseFiles,
  addDroppedFiles,
  t
}: {
  disabled: boolean;
  importing: boolean;
  chooseFiles: () => void;
  addDroppedFiles: (files: File[]) => void;
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
      aria-label={t('dropTitle')}
      onClick={() => !disabled && chooseFiles()}
      onKeyDown={onKeyDown}
      onDragEnter={onDragEnter}
      onDragOver={event => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="drop-icon" aria-hidden="true">
        {importing ? <Spinner /> : '＋'}
      </span>
      <div>
        <strong>
          {importing ? t('importingFiles') : dragging ? t('dropActive') : t('dropTitle')}
        </strong>
        <span>{t('dropFormats')}</span>
      </div>
    </div>
  );
}

export function droppedFiles(files: ArrayLike<File>): File[] {
  return Array.from(files);
}
