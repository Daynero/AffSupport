import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { TeamAnalyticsStorage, TeamPermissions } from '@video-compressor/shared';
import { Button, FormField, Input, Modal } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamApi } from '../../api/team';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import { FolderPicker, type FolderPickerClient } from '../catalog/FolderPicker';
import { useMaterialActions, type MaterialActionsClient } from '../catalog/useMaterialActions';
import type { ActionHandlers } from './useMaterialActionList';
import type { MaterialRef } from './actions';
import { MaterialNoteDialog } from './MaterialNote';

/**
 * The surfaces an action opens, mounted beside the caller rather than inside it.
 *
 * A menu unmounts the moment it closes, so anything it opens has to live
 * somewhere that outlives it. The row menu used to solve this by rendering its
 * rename form and its folder picker *inside itself* — which is why moving a
 * file from a menu once cancelled the move the moment the picker was pressed,
 * and why the fix for that had to be rediscovered locally.
 *
 * Here the host owns them. It returns the handlers the registry needs and the
 * dialogs those handlers open, and a caller renders both: the handlers on the
 * control, the dialogs anywhere.
 */

export interface MaterialActionHostInput {
  teamId: string;
  material: MaterialRef;
  permissions: TeamPermissions;
  browseClient: FolderPickerClient;
  actionsClient?: MaterialActionsClient;
  storageKind?: TeamAnalyticsStorage | null;
  /** Where an upload into this folder lands. */
  destinationFolderId?: string | null;
  /** Replaced when an upload's name clashes with this exact material. */
  replaceMaterialId?: string | null;
  onChanged: () => void;
  /** Raised after a video is trashed, so its transcript companion follows. */
  onTrashed?: () => void;
}

export interface MaterialActionHostResult {
  /** The file operations, ready to hand to `useMaterialActionList`. */
  handlers: ActionHandlers;
  /** Everything those operations put on screen. Render it once, anywhere. */
  dialogs: ReactNode;
  busy: boolean;
}

export function useMaterialActionHost({
  teamId,
  material,
  permissions,
  browseClient,
  actionsClient,
  storageKind = null,
  destinationFolderId = null,
  replaceMaterialId = null,
  onChanged,
  onTrashed
}: MaterialActionHostInput): MaterialActionHostResult {
  const { t } = useI18n();
  const { push } = useToasts();
  const [prompt, setPrompt] = useState<'rename' | 'move' | 'note' | null>(null);
  const [newName, setNewName] = useState(material.name);
  const uploadInput = useRef<HTMLInputElement>(null);

  /**
   * Select the base name, leaving the extension alone.
   *
   * Renaming almost always means replacing the name and keeping `.mp4`, so the
   * field opens with exactly the part that changes already selected. Losing
   * this was the kind of small thing nobody reports and everybody feels.
   *
   * On focus rather than on mount: the dialog decides who gets focus first, and
   * a selection made before that is thrown away by it.
   */
  const selectBaseName = useCallback((event: { currentTarget: HTMLInputElement }) => {
    const node = event.currentTarget;
    const dot = node.value.lastIndexOf('.');
    node.setSelectionRange(0, dot > 0 ? dot : node.value.length);
  }, []);

  const actions = useMaterialActions({
    teamId,
    material: {
      id: material.id,
      teamId: material.teamId,
      name: material.name,
      kind: material.kind,
      category: material.category,
      sizeBytes: material.sizeBytes,
      fileExtension: material.fileExtension
    },
    client: actionsClient,
    storageKind,
    destinationFolderId,
    onChanged
  });

  /**
   * A link to this file, made shareable and put on the clipboard.
   *
   * It lived in a button of its own that only two surfaces rendered, so the
   * same file could be linked from a folder row and not from a search result.
   * `rememberChoice` is what tells the space to keep the sharing it just did,
   * rather than asking again on the next copy.
   */
  const shareLink = async (remember: boolean) => {
    try {
      const result = await teamApi.shareLibraryMaterial({
        teamId,
        materialId: material.id,
        allowIfRestricted: true,
        rememberChoice: remember,
        idempotencyKey: crypto.randomUUID()
      });
      if (result.state !== 'ready') {
        push({ tone: 'error', text: t('teamShareFailed') });
        return;
      }
      try {
        await navigator.clipboard.writeText(result.url);
        push({ tone: 'success', text: t('teamShareCopied') });
      } catch {
        // A browser that refuses the clipboard still made the link; show it.
        push({ tone: 'success', text: `${t('teamShareReady')} ${result.url}` });
      }
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    }
  };

  /**
   * The video's own words, on the clipboard.
   *
   * The transcript is a file beside the video, and reading it meant finding
   * that file — so the text a person had already paid to make was three
   * screens from the video it belongs to. The action appears only when the
   * companion says the text is there, which is why it can fetch on demand
   * rather than holding every transcript in memory.
   */
  const copyText = async () => {
    try {
      const variants = await teamApi.listVideoTextVariants(teamId, material.id);
      // The translation when there is one, as the text block it replaces did:
      // a person who had a video translated wants the translation, and the
      // original is one press away in the text editor.
      const usable = variants.variants.filter(
        variant => variant.ingestState === 'full' && !variant.truncated && variant.text
      );
      const ready = usable.find(variant => variant.kind === 'translation') ?? usable[0];
      if (!ready?.text) {
        push({ tone: 'error', text: t('materialReasonNotReady') });
        return;
      }
      await navigator.clipboard.writeText(ready.text);
      push({ tone: 'success', text: t('creativeLibraryTextCopied') });
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    }
  };

  const handlers: ActionHandlers = {
    copyLink: () => void shareLink(false),
    copyText: () => void copyText(),
    share: () => void shareLink(true),
    download: () => void actions.download(),
    rename: () => {
      setNewName(material.name);
      setPrompt('rename');
    },
    move: () => setPrompt('move'),
    note: () => setPrompt('note'),
    uploadInto: () => uploadInput.current?.click(),
    trash: () =>
      void actions.trash().then(code => {
        if (!code) onTrashed?.();
      }),
    restore: () => void actions.restore()
  };

  const dialogs = (
    <>
      <input
        ref={uploadInput}
        type="file"
        hidden
        // Named even though it is hidden: the browser's own picker announces
        // it, and it is how "upload into this folder" is reached at all.
        aria-label={t('teamFileUpload')}
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void actions.upload(file, 'cancel');
        }}
      />
      {prompt === 'rename' && (
        <Modal
          nested
          size="sm"
          title={t('teamFileRename')}
          onClose={() => setPrompt(null)}
          busy={actions.busy}
          initialFocus="#material-rename-name"
        >
          <form
            className="team-material-inline-form"
            onSubmit={event => {
              event.preventDefault();
              void actions.rename(newName).then(code => {
                if (!code) setPrompt(null);
              });
            }}
          >
            <FormField label={t('teamFileNewName')} htmlFor="material-rename-name">
              <Input
                id="material-rename-name"
                value={newName}
                onFocus={selectBaseName}
                onChange={event => setNewName(event.target.value)}
              />
            </FormField>
            <div className="team-dialog-actions">
              <Button color="neutral" variant="ghost" onClick={() => setPrompt(null)}>
                {t('teamCancel')}
              </Button>
              <Button color="primary" variant="solid" type="submit" loading={actions.busy}>
                {t('teamFileRename')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {prompt === 'note' && (
        <MaterialNoteDialog
          teamId={teamId}
          materialId={material.id}
          name={material.name}
          canEdit={permissions.manage_metadata === true}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'move' && (
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
        <Modal
          nested
          size="sm"
          title={t('teamFileNameConflict')}
          onClose={actions.clearConflict}
          busy={actions.busy}
        >
          <div className="team-dialog-actions">
            <Button color="neutral" variant="ghost" onClick={actions.clearConflict}>
              {t('teamCancel')}
            </Button>
            {permissions.edit && replaceMaterialId && (
              <Button
                color="error"
                variant="soft"
                onClick={() =>
                  void actions.upload(actions.conflictFile as File, 'replace', replaceMaterialId)
                }
              >
                {t('teamFileReplaceExact')}
              </Button>
            )}
            <Button
              color="primary"
              variant="solid"
              onClick={() => void actions.upload(actions.conflictFile as File, 'keep_both')}
            >
              {t('teamFileKeepBoth')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );

  return { handlers, dialogs, busy: actions.busy };
}
