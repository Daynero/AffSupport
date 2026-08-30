import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react';
import type { TeamAnalyticsStorage, TeamPermissions } from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { FolderPicker, type FolderPickerClient } from './FolderPicker';
import {
  useMaterialActions,
  type MaterialActionsClient,
  type RowMaterial
} from './useMaterialActions';

export interface MaterialRowMenuProps {
  teamId: string;
  material: RowMaterial;
  permissions: TeamPermissions;
  client?: MaterialActionsClient;
  /** Reads the folder tree for the destination picker. */
  browseClient: FolderPickerClient;
  onChanged: () => void;
  onEditText?: () => void;
  onProcess?: () => void;
  onRegeneratePreview?: () => void;
  afterTrash?: () => void;
  storageKind?: TeamAnalyticsStorage | null;
  trashed?: boolean;
  replaceMaterialId?: string | null;
  /** The folder this row is being shown in; where a new version lands. */
  destinationFolderId?: string | null;
  folderUploadLabel?: string;
}

/**
 * The per-row actions menu.
 *
 * The whole point of the split is the `open &&` below: the contents — eight
 * pieces of state, two file inputs, a folder picker — exist only while someone
 * is looking at them. A fifty-row page used to mount fifty live copies of all
 * of it inside always-rendered `<details>` elements, which is what made a long
 * list feel heavy (SC-009).
 */
export function MaterialRowMenu(props: MaterialRowMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // A press anywhere outside the menu closes it, the way a menu is expected
    // to behave; it used to stay open over the page until Escape or a choice.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div className="team-row-menu" ref={containerRef}>
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        aria-label={t('teamRowMenuOpen', { name: props.material.name })}
        onClick={() => setOpen(value => !value)}
      >
        {t('teamRowMenuLabel')}
      </Button>
      {open && <MaterialRowMenuContent {...props} onDone={() => setOpen(false)} />}
    </div>
  );
}

type Prompt = { kind: 'rename' } | { kind: 'move' };

function MaterialRowMenuContent({
  teamId,
  material,
  permissions,
  client,
  browseClient,
  onChanged,
  onEditText,
  onProcess,
  onRegeneratePreview,
  afterTrash,
  storageKind = null,
  trashed = false,
  replaceMaterialId = null,
  destinationFolderId = null,
  folderUploadLabel,
  onDone
}: MaterialRowMenuProps & { onDone: () => void }) {
  const { t } = useI18n();
  const actions = useMaterialActions({
    teamId,
    material,
    client,
    storageKind,
    destinationFolderId,
    onChanged
  });
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [newName, setNewName] = useState(material.name);
  const nameInput = useRef<HTMLInputElement | null>(null);

  // The new-name field gets the keyboard the moment it appears, with the base
  // name selected so typing replaces it and the extension survives. Without
  // this the field opened unfocused and Enter went to whatever had focus.
  useEffect(() => {
    if (prompt?.kind !== 'rename') return;
    const input = nameInput.current;
    if (!input) return;
    input.focus();
    const dot = material.name.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : material.name.length);
  }, [material.name, prompt?.kind]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (prompt) setPrompt(null);
      else onDone();
    }
    // Arrows, Enter, space and Delete inside the menu are the menu's own.
    event.stopPropagation();
  };

  const isFolder = material.kind === 'folder';
  const transcriptReady = material.transcriptIngestState === 'full';
  const isTextFile = material.kind === 'file' && material.fileExtension?.toLowerCase() === 'txt';

  const selectUpload = (event: ChangeEvent<HTMLInputElement>, versionOf: string | null) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void actions.upload(file, 'cancel', null, versionOf);
  };

  return (
    <div className="team-row-menu-panel" role="group" onKeyDown={onPanelKeyDown}>
      {prompt === null && (
        <div className="team-material-action-buttons">
          {isFolder && permissions.upload && (
            <label className="button button-secondary">
              {folderUploadLabel ?? t('teamFileUpload')}
              <input
                type="file"
                aria-label={folderUploadLabel ?? t('teamFileUpload')}
                hidden
                onChange={event => selectUpload(event, null)}
              />
            </label>
          )}
          {!isFolder && permissions.download && (
            <Button
              type="button"
              variant="ghost"
              disabled={actions.busy}
              onClick={() => void actions.download()}
            >
              {t('teamFileDownload')}
            </Button>
          )}
          {!isFolder && permissions.upload && destinationFolderId && (
            <label className="button button-ghost">
              {t('teamFileNewVersion')}
              <input
                type="file"
                aria-label={t('teamFileNewVersion')}
                hidden
                onChange={event => selectUpload(event, material.id)}
              />
            </label>
          )}
          {!isFolder && permissions.edit && (
            <>
              <Button type="button" variant="ghost" onClick={() => setPrompt({ kind: 'rename' })}>
                {t('teamFileRename')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setPrompt({ kind: 'move' })}>
                {t('teamFileMove')}
              </Button>
            </>
          )}
          {/* Disabled with a reason rather than absent: the action exists for this
            file, it is the transcript that is not ready yet (FR-015). Silently
            doing nothing — the old behavior — reads as a broken button. */}
          {!isFolder && permissions.edit && isTextFile && onEditText && (
            <Button
              type="button"
              variant="ghost"
              disabled={!transcriptReady}
              title={transcriptReady ? undefined : t('teamFileEditTextUnavailable')}
              onClick={onEditText}
            >
              {t('teamFileEditText')}
            </Button>
          )}
          {!isFolder && permissions.process && onProcess && (
            <Button type="button" variant="ghost" onClick={onProcess}>
              {t('teamFileProcess')}
            </Button>
          )}
          {!isFolder && permissions.edit && onRegeneratePreview && (
            <Button type="button" variant="ghost" onClick={onRegeneratePreview}>
              {t('teamLandingRegenerate')}
            </Button>
          )}
          {!isFolder && permissions.delete && !trashed && (
            <Button
              type="button"
              variant="danger"
              disabled={actions.busy}
              onClick={() =>
                void actions.trash().then(code => {
                  if (!code) {
                    onDone();
                    afterTrash?.();
                  }
                })
              }
            >
              {t('teamFileTrash')}
            </Button>
          )}
          {!isFolder && permissions.delete && trashed && (
            <Button
              type="button"
              variant="secondary"
              disabled={actions.busy}
              onClick={() => void actions.restore().then(code => !code && onDone())}
            >
              {t('teamFileRestore')}
            </Button>
          )}
        </div>
      )}

      {prompt?.kind === 'rename' && (
        <form
          className="team-material-inline-form team-row-menu-rename"
          onSubmit={event => {
            event.preventDefault();
            void actions.rename(newName).then(code => {
              if (!code) {
                setPrompt(null);
                onDone();
              }
            });
          }}
        >
          <label>
            {t('teamFileNewName')}
            <input
              ref={nameInput}
              value={newName}
              onChange={event => setNewName(event.target.value)}
            />
          </label>
          <div className="team-dialog-actions">
            <Button type="submit" loading={actions.busy}>
              {t('teamFileRename')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPrompt(null)}>
              {t('teamCancel')}
            </Button>
          </div>
        </form>
      )}

      {prompt?.kind === 'move' && (
        <FolderPicker
          teamId={teamId}
          client={browseClient}
          title={t('teamFileMoveTitle', { name: material.name })}
          onClose={() => setPrompt(null)}
          onSelect={folder => {
            setPrompt(null);
            void actions.move(folder.id);
          }}
        />
      )}

      {actions.conflictFile && (
        <div className="team-file-conflict" role="alert">
          <p>{t('teamFileNameConflict')}</p>
          <div>
            <Button
              type="button"
              onClick={() => void actions.upload(actions.conflictFile!, 'keep_both')}
            >
              {t('teamFileKeepBoth')}
            </Button>
            {permissions.edit && replaceMaterialId && (
              <Button
                type="button"
                variant="danger"
                onClick={() =>
                  void actions.upload(actions.conflictFile!, 'replace', replaceMaterialId)
                }
              >
                {t('teamFileReplaceExact')}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={actions.clearConflict}>
              {t('teamCancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
