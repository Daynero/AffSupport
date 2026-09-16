import { useRef, useState, type ReactNode } from 'react';
import type { TeamAnalyticsStorage, TeamPermissions } from '@video-compressor/shared';
import { Button, FormField, Input, Modal } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { FolderPicker, type FolderPickerClient } from '../catalog/FolderPicker';
import { useMaterialActions, type MaterialActionsClient } from '../catalog/useMaterialActions';
import type { ActionHandlers } from './useMaterialActionList';
import type { MaterialRef } from './actions';

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
  const [prompt, setPrompt] = useState<'rename' | 'move' | null>(null);
  const [newName, setNewName] = useState(material.name);
  const uploadInput = useRef<HTMLInputElement>(null);

  const actions = useMaterialActions({
    teamId,
    material: {
      id: material.id,
      teamId: material.teamId,
      name: material.name,
      kind: material.kind,
      category: material.category
    },
    client: actionsClient,
    storageKind,
    destinationFolderId,
    onChanged
  });

  const handlers: ActionHandlers = {
    download: () => void actions.download(),
    rename: () => {
      setNewName(material.name);
      setPrompt('rename');
    },
    move: () => setPrompt('move'),
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
            <FormField label={t('teamFileNewName')}>
              <Input autoFocus value={newName} onChange={event => setNewName(event.target.value)} />
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
