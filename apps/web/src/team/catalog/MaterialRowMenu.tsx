import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { TeamAnalyticsStorage, TeamPermissions } from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { teamErrorMessage } from '../errors';
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
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
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

  const isFolder = material.kind === 'folder';
  const transcriptReady = material.transcriptIngestState === 'full';
  const isTextFile = material.kind === 'file' && material.fileExtension?.toLowerCase() === 'txt';

  const selectUpload = (event: ChangeEvent<HTMLInputElement>, versionOf: string | null) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void actions.upload(file, 'cancel', null, versionOf);
  };

  return (
    <div className="team-row-menu-panel" role="group">
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
        {!isFolder && permissions.process && (
          <Button type="button" variant="ghost" onClick={onProcess}>
            {t('teamFileProcess')}
          </Button>
        )}
        {!isFolder && permissions.delete && !trashed && (
          <Button
            type="button"
            variant="danger"
            disabled={actions.busy}
            onClick={() => void actions.trash().then(code => !code && onDone())}
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

      {prompt?.kind === 'rename' && (
        <form
          className="team-material-inline-form"
          onSubmit={event => {
            event.preventDefault();
            void actions.rename(newName).then(code => {
              if (!code) setPrompt(null);
            });
          }}
        >
          <label>
            {t('teamFileNewName')}
            <input value={newName} onChange={event => setNewName(event.target.value)} />
          </label>
          <Button type="submit" loading={actions.busy}>
            {t('teamFileRename')}
          </Button>
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

      {/* A machine code never reaches the page: the mapper turns it into a
          sentence, with a generic one for codes it has not met (FR-014). */}
      {actions.errorCode && (
        <p className="team-inline-error" role="alert">
          {teamErrorMessage(actions.errorCode, t)}
        </p>
      )}
    </div>
  );
}
