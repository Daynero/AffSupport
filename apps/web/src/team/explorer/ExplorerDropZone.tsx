import { useState, type ReactNode, type Ref } from 'react';
import { Upload } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import type { LocalDropEntry, LocalManifestSource } from './localManifest';

/** A file going up, with the path inside the folder it was dropped in. */
export type UploadFile = { file: File; relativePath: string };

/**
 * The open folder as a place files can be dropped (070, FR-001, out of `ExplorerShell`).
 *
 * A drop from the desktop becomes the space's upload group when there is a space to run it
 * (`onDropSources`, folders included), and a plain list of files otherwise (`onDropFiles`).
 * The zone stays lit while anything it took is still going up.
 *
 * While files are held over it, a layer over the list names where they will land (070,
 * FR-008) — «Відпустіть, щоб завантажити в „Креативи"». It used to be a line under the list,
 * which on any folder longer than the window was below the window. A reader who may not upload
 * gets no layer and the browser's "no drop" cursor, and a drop does nothing — before, the
 * browser took the file and navigated away to show it.
 */
export function ExplorerDropZone({
  zoneRef,
  uploading,
  canUpload,
  onDropSources,
  onDropFiles,
  destinationName,
  children
}: {
  zoneRef: Ref<HTMLDivElement>;
  /** How many files are still going up. */
  uploading: number;
  canUpload: boolean;
  onDropSources?: (sources: LocalManifestSource[]) => void;
  onDropFiles: (files: UploadFile[]) => void;
  /** The folder a drop lands in, by the name the reader sees in the path. */
  destinationName: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [dropping, setDropping] = useState(false);
  return (
    <div
      ref={zoneRef}
      className={`team-explorer-main team-explorer-dropzone${dropping ? ' is-over' : ''}${
        uploading > 0 ? ' is-uploading' : ''
      }`}
      aria-busy={uploading > 0 || undefined}
      onDragOver={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        if (!canUpload) {
          event.dataTransfer.dropEffect = 'none';
          return;
        }
        event.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      /* Only when the pointer actually leaves the zone: moving over a tile inside it fired
           this and the outline blinked all the way across the folder. */
      onDragLeave={event => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDropping(false);
        if (!canUpload) return;
        if (onDropSources) onDropSources(sourcesFromDrop(event.dataTransfer));
        else void filesFromDrop(event.dataTransfer).then(onDropFiles);
      }}
    >
      {children}
      {dropping && (
        <div className="team-explorer-drop-layer" role="status">
          <p className="team-explorer-drop-message">
            <Upload size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('teamExplorerDropInto', { name: destinationName })}
          </p>
        </div>
      )}
    </div>
  );
}

/** Browsers expose a dropped directory through DataTransferItem entries, not files. */
function sourcesFromDrop(dataTransfer: DataTransfer): LocalManifestSource[] {
  const sources: LocalManifestSource[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    const entry = item.webkitGetAsEntry?.() as LocalDropEntry | null | undefined;
    if (entry) sources.push({ kind: 'drop_entry', entry });
    else {
      // Entry support can differ between items in one drop. Preserve any
      // readable loose file alongside directory entries rather than dropping it.
      const file = item.getAsFile?.();
      if (file) sources.push({ kind: 'file', file });
    }
  }
  return sources.length > 0
    ? sources
    : Array.from(dataTransfer.files).map(file => ({ kind: 'file', file }));
}

async function filesFromDrop(dataTransfer: DataTransfer): Promise<UploadFile[]> {
  type DropEntry = {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
    file: (success: (file: File) => void, failure?: () => void) => void;
    createReader: () => {
      readEntries: (success: (entries: DropEntry[]) => void, failure?: () => void) => void;
    };
  };
  const items = Array.from(dataTransfer.items);
  if (items.length === 0)
    return Array.from(dataTransfer.files).map(file => ({ file, relativePath: file.name }));
  const files: UploadFile[] = [];
  const visit = async (entry: DropEntry, parentPath = ''): Promise<void> => {
    if (entry.isFile) {
      await new Promise<void>(resolve =>
        entry.file(file => {
          files.push({ file, relativePath: `${parentPath}${file.name}` });
          resolve();
        }, resolve)
      );
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    const read = (): Promise<void> =>
      new Promise<void>(resolve =>
        reader.readEntries(async entries => {
          if (entries.length === 0) return resolve();
          for (const child of entries) await visit(child, `${parentPath}${entry.name}/`);
          await read();
          resolve();
        }, resolve)
      );
    await read();
  };
  for (const item of items) {
    const entry = ((
      item as DataTransferItem & { webkitGetAsEntry?: () => DropEntry | null }
    ).webkitGetAsEntry?.() ?? null) as DropEntry | null;
    if (entry) await visit(entry, '');
    else {
      const file = item.getAsFile?.();
      if (file) files.push({ file, relativePath: file.name });
    }
  }
  return files.length > 0
    ? files
    : Array.from(dataTransfer.files).map(file => ({ file, relativePath: file.name }));
}
