import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
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
  /** Batch actions for a folder's contents (transcribe videos, refresh previews). */
  onProcessFolder?: () => void;
  onRegeneratePreview?: () => void;
  afterTrash?: () => void;
  storageKind?: TeamAnalyticsStorage | null;
  trashed?: boolean;
  replaceMaterialId?: string | null;
  /** The folder this row is being shown in; where a new version lands. */
  destinationFolderId?: string | null;
  folderUploadLabel?: string;
  /**
   * 015 — offered on videos only, beside the original.
   *
   * Absent for every other kind of material, and absent when the shell has nothing to run it
   * with: a menu entry that cannot do anything is worse than no entry.
   */
  onDownloadRestitched?: () => void;
  /**
   * 015 — whether this space has already looked at this video. It changes nothing about what
   * the entry does; it tells the member whether to expect seconds or a wait.
   */
  restitchPrepared?: boolean;
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
  /*
   * Which way the panel opens. It always dropped downward, so on the last rows
   * of a long list it ran past the bottom of the window — measured at 171px
   * off-screen on a 1000px viewport, with "Перемістити в кошик" among the items
   * nobody could reach. Bounding its height did not help: the panel was still
   * *placed* below the fold.
   */
  const [above, setAbove] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

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
      // The folder picker (and rename modal) this menu opens are portaled to the
      // body, outside the menu's own subtree. A press inside one is not "outside
      // the menu": closing here would unmount the menu — and the picker with it —
      // before the picker's own click handler runs, silently cancelling the move.
      if (target instanceof Element && target.closest('[role="dialog"], .modal-backdrop')) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  /*
   * Measured after the panel is in the document, before the browser paints it:
   * if what it needs does not fit under the trigger but does fit over it, it
   * opens upward. Re-measured on scroll and resize, because a row that had room
   * a moment ago may not now.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = containerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const box = trigger.getBoundingClientRect();
      const needed = panel.scrollHeight + 8;
      const below = window.innerHeight - box.bottom;
      setAbove(needed > below && box.top > below);
    };
    place();
    const onChange = () => place();
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    return () => {
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
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
      {open && (
        <MaterialRowMenuContent
          {...props}
          panelRef={panelRef}
          above={above}
          onDone={() => setOpen(false)}
        />
      )}
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
  onProcessFolder,
  onRegeneratePreview,
  afterTrash,
  storageKind = null,
  trashed = false,
  replaceMaterialId = null,
  destinationFolderId = null,
  folderUploadLabel,
  onDownloadRestitched,
  restitchPrepared = false,
  panelRef,
  above,
  onDone
}: MaterialRowMenuProps & {
  panelRef: RefObject<HTMLDivElement | null>;
  /** Opens over the trigger rather than under it; see the measurement above. */
  above: boolean;
  onDone: () => void;
}) {
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
  /* Only what a tool can take. "Обробити" sat on transcripts and images alike
     and opened a dialog with nothing in it. */
  const processable = material.category === 'video' || material.category === 'landing';
  const transcriptReady = material.transcriptIngestState === 'full';
  const isTextFile = material.kind === 'file' && material.fileExtension?.toLowerCase() === 'txt';

  const selectUpload = (event: ChangeEvent<HTMLInputElement>, versionOf: string | null) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void actions.upload(file, 'cancel', null, versionOf);
  };

  return (
    <div
      className={`team-row-menu-panel${above ? ' is-above' : ''}`}
      role="group"
      ref={panelRef}
      onKeyDown={onPanelKeyDown}
    >
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
              {/* Named "the original" only when there is something else it could be. */}
              {onDownloadRestitched ? t('teamRestitchDownloadOriginal') : t('teamFileDownload')}
            </Button>
          )}
          {!isFolder && permissions.download && onDownloadRestitched && (
            <Button
              type="button"
              variant="ghost"
              disabled={actions.busy}
              onClick={() => {
                onDone();
                onDownloadRestitched();
              }}
              title={
                restitchPrepared
                  ? t('teamRestitchMaterialPrepared')
                  : t('teamRestitchMaterialNotPrepared')
              }
            >
              {t('teamRestitchDownloadRestitched')}
              {/* A quiet mark, not a second sentence: the entry works either way. */}
              {restitchPrepared && <span aria-hidden="true"> ·</span>}
              <span className="visually-hidden">
                {restitchPrepared
                  ? ` — ${t('teamRestitchMaterialPrepared')}`
                  : ` — ${t('teamRestitchMaterialNotPrepared')}`}
              </span>
            </Button>
          )}
          {/* "New version" was removed from the menu (owner: unclear, unused);
              replacing content still works through upload + the name-conflict
              "replace" choice. */}
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
          {!isFolder && processable && permissions.process && onProcess && (
            <Button type="button" variant="ghost" onClick={onProcess}>
              {t('teamFileProcess')}
            </Button>
          )}
          {isFolder && permissions.process && onProcessFolder && (
            <Button type="button" variant="ghost" onClick={onProcessFolder}>
              {t('teamFolderProcess')}
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
